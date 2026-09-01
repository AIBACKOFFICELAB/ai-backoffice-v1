export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { Bot, ArrowLeft, Sparkles, Target, ShieldAlert, ThumbsUp } from "lucide-react";
import { getTenantContext } from "@/lib/tenant";
import { getLeads } from "@/lib/leads/repository";
import { SupabaseAgentStore } from "@/lib/agents/agentStore";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { AIStatusBadge } from "@/components/ui/AIStatusBadge";
import { Alert } from "@/components/ui/Alert";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { RecommendationReviewCard } from "@/components/ai/RecommendationReviewCard";
import { ApprovalReadinessEvidence } from "@/components/ai/ApprovalReadinessEvidence";
import { isEstimateClosingShadowEnabled } from "@/lib/agents/estimateClosing/featureFlag";
import { resolveEstimateClosingAgentStatus } from "@/lib/agents/estimateClosing/status";
import { getEstimateClosingEvaluation } from "@/lib/agents/estimateClosing/evaluationReadModel";

/**
 * P1 Sprint 3 §9 — the dedicated Estimate Closing specialist workspace.
 * Not linked from the sidebar (the P1 Sprint 3 directive prefers omitting
 * a permanent nav item over cluttering the IA); reached from the
 * Dashboard's Shadow Insights section and the AI Activity page's Estimate
 * Closing card instead. Server Component throughout except the small
 * ReviewControls client island inside each RecommendationReviewCard.
 */
export default async function EstimateClosingWorkspacePage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const [agents, evaluation, { leads }] = await Promise.all([
    new SupabaseAgentStore().listByTenant(tenant.tenantId),
    getEstimateClosingEvaluation(tenant.tenantId),
    getLeads(tenant.tenantId),
  ]);

  const agentStatus = resolveEstimateClosingAgentStatus(agents);
  const shadowEnabled = isEstimateClosingShadowEnabled();
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));

  return (
    <div className="space-y-8">
      <div>
        <Link href="/agentic" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          AI Activity
        </Link>
        <div className="mt-2">
          <PageHeader
            title="Estimate Closing"
            description="Shadow Mode — observes stalled estimates and recommends next steps. No customer action was taken."
            actions={agentStatus === "active" && shadowEnabled ? <AIStatusBadge mode="shadow" /> : undefined}
          />
        </div>
      </div>

      {/* A. Status */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Status</h2>
        </CardHeader>
        <CardBody>
          {agentStatus === "not_registered" ? (
            <EmptyState icon={<Bot className="h-8 w-8" />} title="No agent registered" description="Estimate Closing is available but has not been configured for this account." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Agent</p>
                <p className="mt-1 text-sm font-semibold text-ink-900">{agentStatus === "active" ? "Active" : "Registered, not running"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Mode</p>
                <p className="mt-1 text-sm font-semibold text-ink-900">Shadow Mode{!shadowEnabled ? " (scans paused)" : ""}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Customer action</p>
                <p className="mt-1 text-sm font-semibold text-ink-900">No customer action was taken</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Latest recommendation</p>
                <p className="mt-1 text-sm font-semibold text-ink-900">{evaluation.latestRecommendationAt ?? "—"}</p>
              </div>
            </div>
          )}

          {!shadowEnabled && agentStatus === "active" && (
            <Alert tone="info" className="mt-4" title="Shadow intelligence is not currently enabled">
              New scans are paused. Showing past recommendations only.
            </Alert>
          )}

          {evaluation.modelFailureCount > 0 && (
            <Alert tone="warning" className="mt-4" title={`${evaluation.modelFailureCount} recent shadow run${evaluation.modelFailureCount === 1 ? "" : "s"} failed`}>
              A model reasoning run did not complete. No customer action was attempted or affected.
            </Alert>
          )}
        </CardBody>
      </Card>

      {agentStatus === "active" && (
        <>
          {/* B. Shadow Performance */}
          <section>
            <h2 className="text-xl font-bold text-ink-900">Shadow performance</h2>
            <p className="text-sm text-ink-500">Every number below reflects the most recent recommendations analyzed — not a lifetime total.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="Recommendations generated" value={evaluation.recommendationsGenerated} icon={<Bot className="h-4 w-4" />} />
              <MetricCard label="Reviewed by owner" value={evaluation.recommendationsReviewed} icon={<ThumbsUp className="h-4 w-4" />} />
              <MetricCard
                label="Owner agreement"
                value={evaluation.agreementRate === null ? "Not enough evidence yet" : `${Math.round(evaluation.agreementRate * 100)}%`}
                helpText={evaluation.recommendationsReviewed > 0 ? `${evaluation.agreeCount} of ${evaluation.recommendationsReviewed} reviewed` : undefined}
                icon={<Sparkles className="h-4 w-4" />}
              />
              <MetricCard
                label="Opportunity value analyzed"
                value={`$${evaluation.opportunityValueAnalyzed.toLocaleString()}`}
                helpText="Not revenue recovered"
                icon={<Target className="h-4 w-4" />}
              />
              <MetricCard
                label="Would-act intent"
                value={`${evaluation.wouldActYes} / ${evaluation.wouldActNo} / ${evaluation.wouldActLater}`}
                helpText="Yes / No / Later"
              />
              <MetricCard
                label="Recommendation mix"
                value={`${evaluation.recommendationBreakdown.followUp} / ${evaluation.recommendationBreakdown.wait} / ${evaluation.recommendationBreakdown.ownerReview}`}
                helpText="Follow up / Wait / Owner review"
              />
              <MetricCard label="Model/run failures" value={evaluation.modelFailureCount} icon={<ShieldAlert className="h-4 w-4" />} tone={evaluation.modelFailureCount > 0 ? "warning" : "default"} />
              <MetricCard label="Malformed records skipped" value={evaluation.skippedMalformedRecommendations + evaluation.skippedMalformedReviews} />
            </div>
          </section>

          {/* C + D. Recommendation Review Queue + Evaluation controls */}
          <section>
            <h2 className="text-xl font-bold text-ink-900">Recommendation review queue</h2>
            <p className="text-sm text-ink-500">Mark whether each recommendation was right, and whether you&rsquo;d act on it. This never sends anything to a customer.</p>
            <div className="mt-4">
              {evaluation.recommendationsWithReviewStatus.length === 0 ? (
                <EmptyState icon={<Bot className="h-8 w-8" />} title="No recommendations yet" description="No stalled estimates have produced a recommendation yet." />
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {evaluation.recommendationsWithReviewStatus.map(({ recommendation, review }) => {
                    const lead = recommendation.leadId ? leadsById.get(recommendation.leadId) : undefined;
                    return (
                      <RecommendationReviewCard
                        key={recommendation.recommendationEventId}
                        recommendationEventId={recommendation.recommendationEventId}
                        recommendation={{
                          recommendation: recommendation.recommendation,
                          confidence: recommendation.confidence,
                          reasonCodes: recommendation.reasonCodes,
                          suggestedChannel: recommendation.suggestedChannel,
                          suggestedTiming: recommendation.suggestedTiming,
                          opportunityValue: recommendation.opportunityValue,
                          rationaleLength: 0,
                        }}
                        serviceType={lead ? `${lead.customerName} — ${lead.serviceType}` : "Estimate"}
                        occurredAt={recommendation.occurredAt}
                        existingReview={review}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* E. Approval Readiness */}
          <section>
            <ApprovalReadinessEvidence
              recommendationsGenerated={evaluation.recommendationsGenerated}
              recommendationsReviewed={evaluation.recommendationsReviewed}
              agreeCount={evaluation.agreeCount}
              agreementRate={evaluation.agreementRate}
              wouldActYes={evaluation.wouldActYes}
              modelFailureCount={evaluation.modelFailureCount}
              toolCallsAttributable={evaluation.toolCallsAttributable}
              approvalsAttributable={evaluation.approvalsAttributable}
              customerActionsAttributable={evaluation.customerActionsAttributable}
            />
          </section>
        </>
      )}
    </div>
  );
}
