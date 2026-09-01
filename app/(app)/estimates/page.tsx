export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { Wallet, Send, Clock, MessageSquareReply, Sparkles, Trophy, XCircle, Bot } from "lucide-react";
import { getTenantContext } from "@/lib/tenant";
import { getLeads } from "@/lib/leads/repository";
import { getEstimateLifecycleReadModel } from "@/lib/leads/estimateLifecycleReadModel";
import type { EstimateLifecycleDiagnosticCode } from "@/lib/leads/estimateLifecycleReadModel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { Alert } from "@/components/ui/Alert";

/**
 * P1 Sprint 4 §10 — the Estimate Pipeline product surface: what has really
 * been sent, where it sits in the deterministic Day 1/3/7 follow-up, and
 * which estimates are Shadow-eligible. Not a replacement for a full
 * job-costing/estimating product (ServiceTitan/Jobber/Housecall Pro) — a
 * thin, honest view over lib/leads/estimateLifecycleReadModel.ts's real
 * data, with zero fabricated figures (P1 Sprint 4 directive §10: "No fake
 * data").
 */

const DIAGNOSTIC_LABEL: Record<EstimateLifecycleDiagnosticCode, string> = {
  estimate_sent_missing_sequence: "Estimate Sent but not enrolled in follow-up",
  sequence_without_estimate_sent_status: "Follow-up active but status changed",
  terminal_lead_with_active_sequence: "Closed lead still has an active follow-up",
  malformed_estimate_amount: "Estimate Sent with no valid dollar amount on file",
};

const DIAGNOSTIC_DESCRIPTION: Record<EstimateLifecycleDiagnosticCode, string> = {
  estimate_sent_missing_sequence: "The lead is marked Estimate Sent but no Day 1/3/7 follow-up sequence exists for it — it will never be automatically followed up or become Shadow-eligible until this is resolved.",
  sequence_without_estimate_sent_status: "A follow-up sequence is still tracked for this lead, but its status is no longer Estimate Sent.",
  terminal_lead_with_active_sequence: "This lead is Won, Lost, or Completed, but its follow-up sequence hasn't stopped yet.",
  malformed_estimate_amount: "This lead is Estimate Sent but has no valid ($0 or missing) estimate amount — it's excluded from Open Estimate Value.",
};

function ShadowBadge({ eligible, stalled }: { eligible: boolean; stalled: boolean }) {
  if (stalled) {
    return <span className="rounded-pill bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-800">Stalled — Shadow eligible</span>;
  }
  if (eligible) {
    return <span className="rounded-pill bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Before Day 7</span>;
  }
  return <span className="rounded-pill bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">Not eligible</span>;
}

function SequenceStageBadge({ nextStep, sequenceStatus }: { nextStep: "day1" | "day3" | "day7" | null; sequenceStatus: string | null }) {
  if (!sequenceStatus) return <span className="rounded-pill bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700">No follow-up</span>;
  if (sequenceStatus === "replied") return <span className="rounded-pill bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">Replied</span>;
  if (sequenceStatus === "completed") return <span className="rounded-pill bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">Day 7 complete</span>;
  if (sequenceStatus === "stopped") return <span className="rounded-pill bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">Stopped</span>;
  const label = nextStep ? `Next: ${nextStep === "day1" ? "Day 1" : nextStep === "day3" ? "Day 3" : "Day 7"}` : "Active";
  return <span className="rounded-pill bg-cyan-100 px-2.5 py-1 text-xs font-semibold text-cyan-800">{label}</span>;
}

export default async function EstimatesPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const [model, { leads: allLeads }] = await Promise.all([getEstimateLifecycleReadModel(tenant.tenantId), getLeads(tenant.tenantId)]);

  const won = allLeads.filter((lead) => lead.status === "Won").length;
  const lost = allLeads.filter((lead) => lead.status === "Lost").length;

  const diagnosticsByCode = new Map<EstimateLifecycleDiagnosticCode, string[]>();
  for (const diag of model.diagnostics) {
    const list = diagnosticsByCode.get(diag.code) ?? [];
    list.push(diag.leadId);
    diagnosticsByCode.set(diag.code, list);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Estimate Pipeline"
        description="Every real estimate sent, where it sits in the deterministic Day 1/3/7 follow-up, and which ones are ready for Shadow intelligence — no fake data, no accelerated timelines."
      />

      {/* A. Summary */}
      <section>
        <h2 className="text-xl font-bold text-ink-900">Summary</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Open estimate value" value={`$${model.openEstimateValue.toLocaleString()}`} helpText="Sent, not yet won or closed" icon={<Wallet className="h-4 w-4" />} />
          <MetricCard label="Sent estimates" value={model.estimatesSent} icon={<Send className="h-4 w-4" />} />
          <MetricCard label="In follow-up" value={model.activeFollowupSequences} helpText="Day 1/3/7 sequence active" icon={<Clock className="h-4 w-4" />} />
          <MetricCard label="Replied" value={model.replied} icon={<MessageSquareReply className="h-4 w-4" />} />
          <MetricCard
            label="Stalled / Shadow eligible"
            value={model.stalledEligible}
            helpText="Past Day 7, no reply — ready for Shadow review"
            icon={<Sparkles className="h-4 w-4" />}
            tone={model.stalledEligible > 0 ? "warning" : "default"}
            href="/agentic/estimate-closing"
          />
          <MetricCard label="Won" value={won} icon={<Trophy className="h-4 w-4" />} />
          <MetricCard label="Lost" value={lost} icon={<XCircle className="h-4 w-4" />} />
        </div>
      </section>

      {/* C. Operational health */}
      {diagnosticsByCode.size > 0 && (
        <section>
          <h2 className="text-xl font-bold text-ink-900">Lifecycle health</h2>
          <p className="text-sm text-ink-500">Data-integrity diagnostics only — nothing here is repaired automatically.</p>
          <div className="mt-4 space-y-3">
            {Array.from(diagnosticsByCode.entries()).map(([code, leadIds]) => (
              <Alert key={code} tone="warning" title={`${DIAGNOSTIC_LABEL[code]} (${leadIds.length})`}>
                <p>{DIAGNOSTIC_DESCRIPTION[code]}</p>
                <p className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-1 text-xs">
                  {leadIds.slice(0, 6).map((leadId) => (
                    <Link key={leadId} href={`/leads/${leadId}`} className="font-semibold underline underline-offset-2 hover:no-underline">
                      View lead
                    </Link>
                  ))}
                  {leadIds.length > 6 && <span>and {leadIds.length - 6} more</span>}
                </p>
              </Alert>
            ))}
          </div>
        </section>
      )}

      {/* B. Lifecycle table */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-ink-900">Sent estimates</h2>
            <p className="text-sm text-ink-500">Every currently open estimate and where it stands.</p>
          </div>
          <Link href="/agentic/estimate-closing" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800">
            <Bot className="h-4 w-4" aria-hidden="true" />
            Estimate Closing workspace &rarr;
          </Link>
        </div>

        <div className="mt-4">
          {model.leads.length === 0 ? (
            <EmptyState
              icon={<Send className="h-8 w-8" />}
              title="No estimates sent yet"
              description="Mark a lead's status as Estimate Sent (with a valid amount) from its detail page or the Lead Inbox to start tracking it here."
            />
          ) : (
            <div className="grid gap-3">
              {model.leads.map((lead) => (
                <Card key={lead.leadId} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Link href={`/leads/${lead.leadId}`} className="font-semibold text-ink-900 hover:underline">
                        {lead.customerName}
                      </Link>
                      <p className="mt-0.5 text-sm text-ink-500">{lead.serviceType}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SequenceStageBadge nextStep={lead.nextFollowupStep} sequenceStatus={lead.sequenceStatus} />
                      <ShadowBadge eligible={lead.shadowEligible} stalled={lead.shadowStalled} />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-700">
                    <p>
                      <span className="font-semibold">Estimate:</span> ${lead.estimateAmount.toLocaleString()}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {model.stalledEligible === 0 && model.estimatesSent > 0 && (
        <Alert tone="info" title="No estimates are Shadow-eligible yet">
          An estimate becomes eligible for Shadow review once its full Day 1/3/7 follow-up window passes with no reply. Nothing here is accelerated.
        </Alert>
      )}
    </div>
  );
}
