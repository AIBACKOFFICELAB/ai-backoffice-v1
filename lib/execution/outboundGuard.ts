/**
 * Server-authoritative outbound-send denial boundary (Founder Beta).
 *
 * Founder Beta stays inside the Shadow-mode / owner-review boundary: no
 * automated SMS/email may be sent on a tenant's behalf. The legacy modules
 * (Estimate Follow-up, Missed Call Recovery) read an `enabled` flag that
 * RLS lets ANY tenant member flip, so that flag is not authorization.
 *
 * Authorization lives here instead, in deployment environment config that
 * tenants cannot reach: outbound sends are DENIED unless the tenant id is
 * explicitly listed in AIBO_OUTBOUND_ALLOWED_TENANT_IDS (comma-separated
 * uuids, set by the Founder in the hosting environment). Unset/empty/
 * malformed -> deny everything. Fail closed.
 *
 * This is checked (a) at the service layer, before any state mutation, and
 * (b) again inside the low-level sendSms/sendEmail/sendOwnerEmergencySms
 * primitives as defense in depth, so a future caller cannot bypass it.
 */

export const OUTBOUND_ALLOWLIST_ENV = "AIBO_OUTBOUND_ALLOWED_TENANT_IDS";

export type OutboundContext = { tenantId?: string | null };

export type OutboundDecision = { allowed: true } | { allowed: false; reason: "outbound-denied" };

function allowedTenantIds(): Set<string> {
  const raw = process.env[OUTBOUND_ALLOWLIST_ENV] ?? "";
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function checkOutboundAllowed(ctx?: OutboundContext): OutboundDecision {
  const tenantId = ctx?.tenantId?.trim().toLowerCase();
  if (!tenantId) return { allowed: false, reason: "outbound-denied" };
  return allowedTenantIds().has(tenantId) ? { allowed: true } : { allowed: false, reason: "outbound-denied" };
}
