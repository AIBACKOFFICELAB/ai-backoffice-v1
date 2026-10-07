import "server-only";
import { createClient } from "@supabase/supabase-js";
import { emitEvent } from "@/lib/events/service";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import { createCanonicalLeadFromIntake } from "@/lib/leads/intake/service";
import { createLiveIntakeDeps } from "@/lib/leads/intake/server";
import type { Agent } from "@/lib/agents/types";
import { parseRevenueDeskConfig, ConfigError } from "./config";
import { bookingUniqueViolation, type Booking, type BookingStore } from "./booking";
import type { CallPatch, CallRow, RevenueDeskStore } from "./service";
import { revenueDeskAgentDefinition } from "./tools";

/** Cookie-free service-role client, private to the Revenue Desk adapter
 * (provider webhooks carry no user session). Every query is explicitly
 * tenant-filtered; RLS is the backstop for member reads. */
function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Revenue Desk database unavailable");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(8000) }) },
  });
}

const CALL_COLS = "id, tenant_id, provider_call_id, caller_phone, lead_id, status, priority, intake, escalation_reason";
function mapCall(r: Record<string, any>): CallRow {
  return { id: r.id, tenantId: r.tenant_id, providerCallId: r.provider_call_id, callerPhone: r.caller_phone, leadId: r.lead_id, status: r.status, priority: r.priority, intake: r.intake, escalationReason: r.escalation_reason };
}

const PATCH_COLUMNS: Record<keyof CallPatch, string> = {
  status: "status", leadId: "lead_id", priority: "priority", urgencySignals: "urgency_signals", serviceCategory: "service_category",
  intake: "intake", escalationReason: "escalation_reason", escalationResult: "escalation_result", bookingOutcome: "booking_outcome",
  availabilityCheckedAt: "availability_checked_at", endedAt: "ended_at", startedAt: "started_at", durationSeconds: "duration_seconds",
  providerCostUsd: "provider_cost_usd", endedReason: "ended_reason", failureCategory: "failure_category",
};

export function createRevenueDeskStore(): RevenueDeskStore {
  const client = db();
  const events = new SupabaseBusinessEventStore(async () => client as any);
  return {
    async resolveTenantByProviderNumber(providerPhoneNumberId) {
      const { data, error } = await client.from("revenue_desk_settings").select("*, tenants:tenant_id (name, status)").eq("vapi_phone_number_id", providerPhoneNumberId).maybeSingle();
      if (error) throw new Error("tenant resolution unavailable");
      if (!data) return null;
      const tenant = Array.isArray(data.tenants) ? data.tenants[0] : data.tenants;
      if (!tenant || tenant.status !== "active") return null;
      try {
        return { config: parseRevenueDeskConfig(data, tenant.name) };
      } catch (e) {
        if (e instanceof ConfigError) {
          console.error("[revenue-desk] invalid tenant configuration", { tenantId: data.tenant_id, problem: e.message });
          return null;
        }
        throw e;
      }
    },

    async upsertCall(i) {
      const row = { tenant_id: i.tenantId, provider: "vapi", provider_call_id: i.providerCallId, provider_phone_number_id: i.providerPhoneNumberId, caller_phone: i.callerPhone, called_phone: i.calledPhone, started_at: i.startedAt };
      const ins = await client.from("revenue_desk_calls").insert(row).select(CALL_COLS).single();
      if (!ins.error) return { call: mapCall(ins.data), created: true };
      if (ins.error.code !== "23505") throw new Error("call persist failed");
      const existing = await client.from("revenue_desk_calls").select(CALL_COLS).eq("tenant_id", i.tenantId).eq("provider", "vapi").eq("provider_call_id", i.providerCallId).single();
      if (existing.error) throw new Error("call lookup failed");
      return { call: mapCall(existing.data), created: false };
    },

    async updateCall(tenantId, callId, patch) {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [k, v] of Object.entries(patch)) row[PATCH_COLUMNS[k as keyof CallPatch]] = v;
      const { error } = await client.from("revenue_desk_calls").update(row).eq("tenant_id", tenantId).eq("id", callId);
      if (error) throw new Error("call update failed");
    },

    async getAgent(tenantId): Promise<Agent | null> {
      const { data, error } = await client.from("agents").select("*").eq("tenant_id", tenantId).eq("agent_type", "csr_lead_recovery").maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id, tenantId: data.tenant_id, agentType: data.agent_type, name: data.name, purpose: data.purpose, status: data.status,
        allowedTools: data.allowed_tools ?? [], readScopes: data.read_scopes ?? [], writeScopes: data.write_scopes ?? [],
        approvalPolicy: data.approval_policy ?? {}, modelPolicy: data.model_policy ?? {}, systemInstructions: data.system_instructions,
        instructionsVersion: data.instructions_version ?? 1, createdAt: data.created_at, updatedAt: data.updated_at,
      };
    },

    async createLead(tenantId, payload) {
      const { data: tenant, error } = await client.from("tenants").select("id, name, email").eq("id", tenantId).single();
      if (error || !tenant) throw new Error("tenant unavailable");
      // Reuse canonical intake persistence + lead.created, but with NO owner email:
      // Revenue Desk must not introduce any outbound email path.
      const deps = { ...createLiveIntakeDeps(), notify: async () => {} };
      const result = await createCanonicalLeadFromIntake(payload, tenant, "voice_receptionist", null, deps);
      return result.lead.id;
    },

    async emit(input) {
      await emitEvent(input, events);
    },
  };
}

function mapBooking(r: Record<string, any>): Booking {
  return {
    id: r.id, tenantId: r.tenant_id, callId: r.call_id, leadId: r.lead_id, idempotencyKey: r.idempotency_key, calendarId: r.calendar_id,
    start: new Date(r.requested_start).toISOString(), end: new Date(r.requested_end).toISOString(), timezone: r.timezone,
    providerEventId: r.provider_event_id, status: r.status, failureCategory: r.failure_category, updatedAt: r.updated_at,
  };
}

export function createBookingStore(): BookingStore {
  const client = db();
  return {
    async findByIdempotencyKey(tenantId, key) {
      const { data, error } = await client.from("revenue_desk_bookings").select("*").eq("tenant_id", tenantId).eq("idempotency_key", key).maybeSingle();
      if (error) throw new Error("booking lookup failed");
      return data ? mapBooking(data) : null;
    },
    async insertPending(b) {
      const { data, error } = await client
        .from("revenue_desk_bookings")
        .insert({ tenant_id: b.tenantId, call_id: b.callId, lead_id: b.leadId, idempotency_key: b.idempotencyKey, calendar_id: b.calendarId, requested_start: b.start, requested_end: b.end, timezone: b.timezone })
        .select("*")
        .single();
      if (!error) return mapBooking(data);
      const guard = error.code === "23505" ? bookingUniqueViolation(error.message) : null;
      if (guard) throw guard; // caller re-reads the authoritative row before answering
      throw new Error("booking persist failed");
    },
    async claimPending(tenantId, id, expectedUpdatedAt) {
      // Compare-and-set on the lease timestamp: at most one concurrent retry wins.
      const { data, error } = await client
        .from("revenue_desk_bookings")
        .update({ updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", id).eq("status", "pending").eq("updated_at", expectedUpdatedAt)
        .select("*")
        .maybeSingle();
      if (error) throw new Error("booking claim failed");
      return data ? mapBooking(data) : null;
    },
    async update(tenantId, id, patch) {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.providerEventId !== undefined) row.provider_event_id = patch.providerEventId;
      if (patch.failureCategory !== undefined) row.failure_category = patch.failureCategory;
      const { data, error } = await client.from("revenue_desk_bookings").update(row).eq("tenant_id", tenantId).eq("id", id).select("*").single();
      if (error || !data) throw new Error("booking update failed");
      return mapBooking(data);
    },
  };
}

export { revenueDeskAgentDefinition };
