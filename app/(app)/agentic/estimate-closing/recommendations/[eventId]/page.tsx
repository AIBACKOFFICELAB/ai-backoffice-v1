export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Bot, ShieldCheck } from "lucide-react";
import { getTenantContext } from "@/lib/tenant";
import { getLeadById } from "@/lib/leads/repository";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { RecommendationReviewCard } from "@/components/ai/RecommendationReviewCard";
import { getEstimateClosingRecommendationEvidence } from "@/lib/agents/estimateClosing/recommendationEvidence";
import { labelChannel, labelTiming } from "@/lib/agents/estimateClosing/labels";

const RUN_STATUS_LABEL: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  awaiting_approval: "Awaiting approval",
  denied: "Denied",
  partial: "Partial",
  cancelled: "Cancelled",
};

/**
 * P1 Sprint 5 §13 — the first-recommendation evidence detail experience.
 * Reuses the EXISTING RecommendationReviewCard (which itself reuses
 * ShadowRecommendationCard + ReviewControls) for the recommendation +
 * owner-review sections — there is no second review system here. Every
 * other field on this page comes from
 * lib/agents/estimateClosing/recommendationEvidence.ts, which already
 * labels anything it cannot safely resolve as unavailable rather than
 * fabricating a relation.
 */
export default async function RecommendationEvidencePage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const evidence = await getEstimateClosingRecommendationEvidence({ tenantId: tenant.tenantId, recommendationEventId: eventId });

  if (!evidence.found) {
    return (
      <div className="space-y-6">
        <Link href="/agentic/estimate-closing" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Estimate Closing
        </Link>
        <EmptyState
          icon={<Bot className="h-8 w-8" />}
          title="Recommendation not found"
          description="This recommendation doesn't exist for your account, or its record could not be read."
        />
      </div>
    );
  }

  const { lead } = evidence.recommendation.leadId ? await getLeadById(evidence.recommendation.leadId, tenant.tenantId) : { lead: undefined };
  const serviceLabel = lead ? `${lead.customerName} — ${lead.serviceType}` : "Estimate";
  const timingLabel = labelTiming(evidence.recommendation.suggestedTiming);
  // A recorded reply (already shown under "Reply received" in Lifecycle
  // context above) IS customer response evidence — showing it there while
  // the Attribution ladder unconditionally claimed "NOT OBSERVED" was
  // self-contradictory (Codex review finding on PR #24, P2). Revenue
  // attribution stays explicitly unestablished regardless — a reply alone
  // never implies the job was won or revenue recovered.
  const customerResponseObserved = evidence.sequence?.lastReplyAt != null;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/agentic/estimate-closing" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Estimate Closing
        </Link>
        <div className="mt-2">
          <PageHeader title="Recommendation detail" description="Full privacy-safe evidence for one Shadow Mode recommendation. No customer action was taken." />
        </div>
      </div>

      {/* A. Recommendation + D. Owner evaluation — reuses the existing
          review system entirely; never a second one. */}
      <RecommendationReviewCard
        recommendationEventId={evidence.recommendation.recommendationEventId}
        recommendation={{
          recommendation: evidence.recommendation.recommendation,
          confidence: evidence.recommendation.confidence,
          reasonCodes: evidence.recommendation.reasonCodes,
          suggestedChannel: evidence.recommendation.suggestedChannel,
          suggestedTiming: evidence.recommendation.suggestedTiming,
          opportunityValue: evidence.recommendation.opportunityValue,
          rationaleLength: 0,
        }}
        serviceType={serviceLabel}
        occurredAt={evidence.recommendation.occurredAt}
        existingReview={evidence.review}
      />

      {/* B. Lifecycle context */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Lifecycle context</h2>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Current lead status</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.leadStatus ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Follow-up sequence stage</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.sequence?.status ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Estimate sent</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.sequence?.estimateSentAt ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Day 7 due</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.sequence?.day7DueAt ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Reply received</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.sequence ? (evidence.sequence.lastReplyAt ? evidence.sequence.lastReplyAt : "No") : "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Suggested next step</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">
                {labelChannel(evidence.recommendation.suggestedChannel)}
                {timingLabel ? ` — ${timingLabel}` : ""}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {/* C. Intelligence evidence */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Intelligence evidence</h2>
          <p className="mt-0.5 text-sm text-ink-500">What the system actually did to produce this recommendation — and confirmation of what it did not do.</p>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Stalled event</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.stalledEventFound ? `Found (${evidence.stalledEventOccurredAt})` : "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Agent run</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">
                {evidence.agentRun ? (RUN_STATUS_LABEL[evidence.agentRun.status] ?? evidence.agentRun.status) : "Unavailable"}
              </dd>
              {evidence.agentRun?.failureReason && <dd className="mt-1 text-xs text-danger-600">{evidence.agentRun.failureReason}</dd>}
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Model invocation</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">
                {evidence.modelInvocation ? `${evidence.modelInvocation.provider} / ${evidence.modelInvocation.model} — ${evidence.modelInvocation.status}` : "Unavailable"}
              </dd>
              {evidence.modelInvocation?.errorCategory && <dd className="mt-1 text-xs text-danger-600">Error category: {evidence.modelInvocation.errorCategory}</dd>}
              {evidence.modelInvocation?.latencyMs != null && <dd className="mt-1 text-xs text-ink-400">{evidence.modelInvocation.latencyMs}ms</dd>}
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Tool call</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.toolCallExists ? "Exists" : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Approval</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.approvalExists ? "Exists" : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Customer action</dt>
              <dd className="mt-1 text-sm font-semibold text-ink-900">{evidence.customerActionExists ? "Exists" : "None"}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {/* Attribution evidence ladder — P1 Sprint 5 §19: evidence-state UX
          only, never an inferred outcome. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-ink-400" aria-hidden="true" />
            <h2 className="font-semibold text-ink-900">Attribution evidence</h2>
          </div>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">AI recommendation</dt>
              <dd className="mt-1 text-sm font-bold text-success-700">RECORDED</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Owner review</dt>
              <dd className={`mt-1 text-sm font-bold ${evidence.review ? "text-success-700" : "text-ink-500"}`}>{evidence.review ? "RECORDED" : "NOT YET"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Customer response evidence</dt>
              <dd className={`mt-1 text-sm font-bold ${customerResponseObserved ? "text-success-700" : "text-ink-500"}`}>
                {customerResponseObserved ? "OBSERVED" : "NOT OBSERVED"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">Revenue attribution</dt>
              <dd className="mt-1 text-sm font-bold text-ink-500">NOT ESTABLISHED</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
