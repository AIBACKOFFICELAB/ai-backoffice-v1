import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenant";
import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { EmitEventInput } from "@/lib/events/types";

/**
 * Owner Evidence Persistence Hotfix — Estimate Closing Shadow review +
 * follow-through.
 *
 * ROOT CAUSE: `lib/agents/estimateClosing/review.ts` and `followThrough.ts`
 * both default to `new SupabaseBusinessEventStore()` (the SHARED, cookie-
 * bound SSR client — see `lib/supabase/server.ts::createServerSupabaseClient`).
 * `business_events` has always had exactly one RLS policy
 * (`business_events_select_tenant`, SELECT-only — migration 009); there has
 * never been an authenticated INSERT policy. `@supabase/ssr`'s
 * `createServerClient` propagates the CALLER's own session as the
 * `Authorization` bearer header regardless of which key initialized the
 * client, so — despite `createServerSupabaseClient()` being constructed
 * with `SUPABASE_SERVICE_ROLE_KEY` — every request made through it while a
 * real user session is present is evaluated by Postgres as that user's own
 * `authenticated` role, never `service_role`. The `getById`/`listByTenant`
 * reads on that path have always worked (SELECT is exactly what
 * `business_events_select_tenant` grants); every INSERT attempted through
 * it — the final `emitEvent()` call in both review.ts and followThrough.ts
 * — was always silently rejected by RLS as soon as a real (non-service-
 * role) owner tried it, which is exactly what happened to the Founder's
 * first genuine review attempt.
 *
 * FIX (this module): follow the exact accepted pattern from
 * `lib/leads/estimateLifecycleEvent.server.ts` — a private, cookie-free
 * service-role client, never exported, used ONLY for the final bounded
 * `business_events` INSERT, and ONLY after independently re-verifying,
 * through the CALLER's own authenticated/RLS-governed client (never merely
 * trusted because it was passed in as a parameter), that: the current user
 * is genuinely authenticated; their tenant/user id match what the caller
 * claims; their role is `owner`; and the referenced recommendation event
 * genuinely exists, in the SAME tenant, with `eventType ===
 * "estimate.closing_recommendation_generated"`. `eventType` itself is
 * restricted to a fixed, hardcoded set of exactly two values — this store
 * grants NO general `business_events` write authority, only these two
 * specific owner-evidence event types, for Estimate Closing specifically.
 *
 * `review.ts`/`followThrough.ts` are UNCHANGED beyond which `BusinessEventStore`
 * they construct by default — every existing validation, idempotency-key,
 * and dedup-handling code path in both files is untouched, so their
 * existing pure-unit-test coverage (with an injected `InMemoryBusinessEventStore`)
 * remains valid unchanged. `getById`/`listByTenant` on this store still use
 * the plain authenticated client (identical to before — reads were never
 * broken); only `insert()` differs.
 */

const ALLOWED_EVENT_TYPES = new Set<string>([
  "estimate.closing_recommendation_reviewed",
  "estimate.closing_recommendation_followthrough_recorded",
]);

const RECOMMENDATION_EVENT_TYPE = "estimate.closing_recommendation_generated";

/** Private, cookie-free client — never exported. Mirrors
 * lib/leads/estimateLifecycleEvent.server.ts::eventClient exactly. */
function eventClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Estimate Closing evidence database unavailable");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }) },
  });
}

/**
 * A `BusinessEventStore` scoped to Estimate Closing owner evidence only.
 * `getById`/`listByTenant` delegate to the ordinary authenticated client
 * (reads were never broken — `business_events_select_tenant` already
 * permits them). `insert` is the elevated, verified path: it re-derives the
 * acting user/tenant/role fresh from the live session (never trusting
 * `input.tenantId`/`input.actorId` alone), re-confirms the referenced
 * recommendation event independently through the SAME authenticated
 * client, rejects any `eventType` outside the fixed allow-list, and only
 * then performs the actual INSERT via the private service-role client.
 * The elevated client itself is never exposed outside this class.
 */
class EstimateClosingEvidenceEventStore implements BusinessEventStore {
  private readonly authenticated = new SupabaseBusinessEventStore(createServerSupabaseClient);
  private readonly elevated = new SupabaseBusinessEventStore(async () => eventClient());

  async getById(tenantId: string, id: string) {
    return this.authenticated.getById(tenantId, id);
  }

  async listByTenant(tenantId: string, opts?: { eventType?: string; limit?: number; offset?: number; causationIdIn?: string[] }) {
    return this.authenticated.listByTenant(tenantId, opts);
  }

  async insert(input: EmitEventInput) {
    if (!ALLOWED_EVENT_TYPES.has(input.eventType)) {
      throw new Error(`Estimate Closing evidence writer refused an unrecognized event type: ${input.eventType}`);
    }
    if (!input.actorId) {
      throw new Error("Estimate Closing evidence authorization failed: no acting user");
    }
    if (!input.causationId) {
      throw new Error("Estimate Closing evidence authorization failed: no source recommendation reference");
    }

    // Re-derive the acting user/tenant/role FRESH from the live session —
    // input.tenantId/input.actorId are never trusted merely because
    // review.ts/followThrough.ts already resolved them upstream (defense
    // in depth against a future regression that passes them incorrectly),
    // mirroring emitEstimateSentEvent's identical re-check.
    const tenant = await getTenantContext();
    if (!tenant || tenant.tenantId !== input.tenantId || tenant.userId !== input.actorId || tenant.role !== "owner") {
      throw new Error("Estimate Closing evidence authorization failed");
    }

    // Independently re-confirm the referenced recommendation event exists,
    // in the SAME tenant, and is genuinely a recommendation-generated
    // event — through the authenticated/RLS-governed client, never merely
    // trusted because a caller supplied a causationId/entityType/entityId.
    const recommendationEvent = await this.authenticated.getById(input.tenantId, input.causationId);
    if (!recommendationEvent || recommendationEvent.eventType !== RECOMMENDATION_EVENT_TYPE) {
      throw new Error("Estimate Closing evidence authorization failed: source recommendation not found");
    }
    if (recommendationEvent.entityType !== (input.entityType ?? null) || recommendationEvent.entityId !== (input.entityId ?? null)) {
      throw new Error("Estimate Closing evidence authorization failed: entity mismatch");
    }

    return this.elevated.insert(input);
  }
}

export function createEstimateClosingEvidenceEventStore(): BusinessEventStore {
  return new EstimateClosingEvidenceEventStore();
}
