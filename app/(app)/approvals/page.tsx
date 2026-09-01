export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { SupabaseApprovalStore } from "@/lib/approvals/store";
import { SupabaseAgentStore } from "@/lib/agents/agentStore";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { ApprovalModeLadder } from "@/components/ai/ApprovalModeLadder";
import { classifyApprovalBucket, isEffectivelyExpired, ApprovalDisplayBucket } from "@/lib/approvals/display";
import type { Approval } from "@/lib/approvals/types";

/**
 * P1 Sprint 3 §11 — Human Approval Center UI foundation. Built on the
 * CURRENT approval service (lib/approvals/service.ts, lib/approvals/store.ts)
 * — no new backend semantics. This page does not activate anything: it
 * lists whatever approvals already exist (today, none — no active agent
 * in this codebase has a code path capable of requesting one; Estimate
 * Closing is structurally shadow-only, see shadowRunner.ts). Building this
 * now is infrastructure/UI readiness (P1 Sprint 3 directive §12), not an
 * activation of Estimate Closing approval mode.
 */
export default async function ApprovalsPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const [approvals, agents] = await Promise.all([
    new SupabaseApprovalStore().listByTenant(tenant.tenantId),
    new SupabaseAgentStore().listByTenant(tenant.tenantId),
  ]);

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  // Bucketed by CLASSIFIED status, not raw `approval.status` — a
  // still-'pending' row past its own deadline must display (and behave)
  // as expired even before the backend's lazy transition has run against
  // it (Codex review finding on PR #21; see lib/approvals/display.ts).
  const now = new Date();
  const byBucket = (bucket: ApprovalDisplayBucket) => approvals.filter((a) => classifyApprovalBucket(a, now) === bucket);

  const pending = byBucket("pending");
  const approved = byBucket("approved");
  const rejected = byBucket("rejected");
  const expired = byBucket("expired");

  const canDecide = tenant.role === "owner";

  function renderList(list: Approval[], emptyTitle: string, emptyDescription: string) {
    if (list.length === 0) {
      return <EmptyState title={emptyTitle} description={emptyDescription} />;
    }
    return (
      <div className="grid gap-3">
        {list.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approvalId={approval.id}
            requestedAction={approval.requestedAction}
            riskLevel={approval.riskLevel}
            status={approval.status}
            createdAt={approval.createdAt}
            expiresAt={approval.expiresAt}
            agentName={approval.agentId ? (agentNameById.get(approval.agentId) ?? "Agent") : "Agent"}
            payloadDigest={approval.payloadDigest}
            canDecide={canDecide}
            effectivelyExpired={isEffectivelyExpired(approval, now)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Approvals" description="Every action an agent has asked you to sign off on — governed, auditable, and never automatic." />

      <section>
        <h2 className="text-xl font-bold text-ink-900">Trust progression</h2>
        <p className="text-sm text-ink-500">AI BackOffice earns autonomy in stages. Nothing here is enabled without your explicit authorization.</p>
        <div className="mt-4">
          <ApprovalModeLadder />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold text-ink-900">Pending ({pending.length})</h2>
        <div className="mt-4">{renderList(pending, "No approval requests", "Actions an agent needs your sign-off for will appear here.")}</div>
      </section>

      <section>
        <h2 className="text-xl font-bold text-ink-900">Approved ({approved.length})</h2>
        <div className="mt-4">{renderList(approved, "No approved requests yet", "Decisions you've approved will appear here.")}</div>
      </section>

      <section>
        <h2 className="text-xl font-bold text-ink-900">Rejected ({rejected.length})</h2>
        <div className="mt-4">{renderList(rejected, "No rejected requests", "Decisions you've rejected will appear here.")}</div>
      </section>

      <section>
        <h2 className="text-xl font-bold text-ink-900">Expired ({expired.length})</h2>
        <div className="mt-4">{renderList(expired, "No expired requests", "A pending request that timed out before you decided will appear here.")}</div>
      </section>
    </div>
  );
}
