export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { Bot, ArrowLeft, Sparkles, Target, ShieldAlert, ThumbsUp, Clock, Radar, CheckCircle2 } from "lucide-react";
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
import { getEstimateClosingOperations } from "@/lib/agents/estimateClosing/operationsReadModel";
import { getEstimateClosingCommercialEvidence } from "@/lib/agents/estimateClosing/commercialEvidence";
import { getEstimateLifecycleReadModel, buildShadowReadinessLines } from "@/lib/leads/estimateLifecycleReadModel";
import { formatOperationalTimestamp } from "@/lib/format/timestamp";

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

  const [agents, evaluation, { leads }, lifecycle, operations, commercialEvidence] = await Promise.all([
    new SupabaseAgentStore().listByTenant(tenant.tenantId),
    getEstimateClosingEvaluation(tenant.tenantId),
    getLeads(tenant.tenantId),
    getEstimateLifecycleReadModel(tenant.tenantId),
    getEstimateClosingOperations(tenant.tenantId),
    getEstimateClosingCommercialEvidence(tenant.tenantId),
  ]);
  const readinessLines = buildShadowReadinessLines(lifecycle);

  const agentStatus = resolveEstimateClosingAgentStatus(agents);
  const shadowEnabled = isEstimateClosingShadowEnabled();
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
  // P1 Sprint 6 visual acceptance hotfix — same raw-ISO presentation
  // defect as /agentic's identical "Last durable scan" card, sourced from
  // the same operations.lastScanAt value. Presentation only.
  const formattedLastScanAt = formatOperationalTimestamp(operations.lastScanAt);

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

      {/* Shadow data readiness (P1 Sprint 4 §12) — truthful, never accelerated */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Shadow data readiness</h2>
          <p className="mt-1 text-sm text-ink-500">How many real estimates exist, and how close they are to Shadow eligibility. Nothing here is accelerated or forced.</p>
        </CardHeader>
        <CardBody className="space-y-1.5">
          {readinessLines.map((line) => (
            <p key={line} className="text-sm text-ink-700">{line}</p>
          ))}
          <Link href="/estimates" className="mt-2 inline-block text-sm font-semibold text-brand-700 hover:text-brand-800">
            View Estimate Pipeline &rarr;
          </Link>
        </CardBody>
      </Card>

      {/* Operations (P1 Sprint 5 §16) — is the scheduled scan actually
          running, and what did it observe? Distinct from Shadow Performance
          below: this section is about SCAN activity (a heartbeat), not
          recommendation quality. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-ink-400" aria-hidden="true" />
            <h2 className="font-semibold text-ink-900">Operations</h2>
          </div>
          <p className="mt-0.5 text-sm text-ink-500">
            Whether the scheduled scan actually ran, and what it found. Expected schedule: daily. Absence of a recorded scan is not evidence it ran.
          </p>
        </CardHeader>
        <CardBody>
          {operations.scanTelemetryStatus === "no_telemetry" ? (
            <EmptyState
              icon={<Clock className="h-8 w-8" />}
              title="No durable scan telemetry has been recorded yet"
              description="The scheduled scan hasn't produced a durable record for this account yet."
            />
          ) : (
            <>
              {operations.scanTelemetryStatus === "failure_recorded" && (
                <Alert tone="danger" className="mb-4" title="The last scan attempt failed">
                  {`Error category: ${operations.latestScanFailureCategory ?? "unknown"}. No customer action was possible either way.`}
                </Alert>
              )}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label="Last durable scan"
                  value={formattedLastScanAt?.display ?? "—"}
                  valueTitle={formattedLastScanAt?.title}
                  truncateValue
                  icon={<Clock className="h-4 w-4" />}
                />
                <MetricCard label="Candidates scanned" value={operations.latestScanCounts?.candidatesScanned ?? "—"} />
                <MetricCard label="Stalled found" value={operations.latestScanCounts?.stalledFound ?? "—"} />
                <MetricCard label="Shadow attempts" value={operations.latestScanCounts?.shadowAttempts ?? "—"} />
                <MetricCard label="Recommendation successes" value={operations.latestScanCounts?.succeeded ?? "—"} />
                <MetricCard
                  label="Failures (latest scan)"
                  value={operations.latestScanCounts?.failed ?? "—"}
                  tone={(operations.latestScanCounts?.failed ?? 0) > 0 ? "warning" : "default"}
                />
                <MetricCard
                  label="Pending owner reviews"
                  value={operations.recommendationsAwaitingReview}
                  icon={<ThumbsUp className="h-4 w-4" />}
                  tone={operations.recommendationsAwaitingReview > 0 ? "warning" : "default"}
                />
                <MetricCard
                  label="Model/run failures"
                  value={operations.modelFailureCount}
                  helpText={operations.latestModelFailureCategory ? `Latest: ${operations.latestModelFailureCategory}` : undefined}
                  tone={operations.modelFailureCount > 0 ? "warning" : "default"}
                />
              </div>
              {operations.malformedScanTelemetryCount > 0 && (
                <p className="mt-4 text-xs text-ink-400">{operations.malformedScanTelemetryCount} telemetry record(s) could not be read and were excluded.</p>
              )}
            </>
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
                      <div key={recommendation.recommendationEventId} className="space-y-1.5">
                        <RecommendationReviewCard
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
                        <Link
                          href={`/agentic/estimate-closing/recommendations/${encodeURIComponent(recommendation.recommendationEventId)}`}
                          className="inline-block text-xs font-semibold text-brand-700 hover:text-brand-800"
                        >
                          View full evidence &rarr;
                        </Link>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Commercial evidence — P1 Sprint 6 §17. Restrained: what
              actually happened after a recommendation, in the owner's own
              words. Never "AI wins", never "revenue recovered", never a
              conversion rate — see commercialEvidence.ts's own doc comment
              on the constitutional attribution rule this section obeys. */}
          <section>
            <h2 className="text-xl font-bold text-ink-900">Commercial evidence</h2>
            <p className="text-sm text-ink-500">What actually happened after each recommendation — recorded by you, not inferred by AI.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Recommendations with follow-through"
                value={commercialEvidence.followthroughRecorded}
                icon={<CheckCircle2 className="h-4 w-4" />}
                helpText={
                  commercialEvidence.followThroughCoverageRate === null
                    ? "Not enough evidence yet"
                    : `${Math.round(commercialEvidence.followThroughCoverageRate * 100)}% of ${commercialEvidence.recommendationsGenerated} recommendations`
                }
              />
              <MetricCard
                label="Owner actions recorded"
                value={`${commercialEvidence.actedYes} / ${commercialEvidence.actedNo} / ${commercialEvidence.actedLater}`}
                helpText="Yes / No / Later"
              />
              <MetricCard label="Customer responses observed" value={commercialEvidence.customerResponsesObserved} />
              <MetricCard
                label="Owner-reported wins"
                value={commercialEvidence.ownerReportedWon}
                helpText="Owner-reported, not AI-attributed revenue"
              />
              <MetricCard label="Owner-reported losses" value={commercialEvidence.ownerReportedLost} />
              <MetricCard label="Owner-reported still pending" value={commercialEvidence.ownerReportedPending} />
              <MetricCard
                label="Follow-through still missing"
                value={commercialEvidence.recommendationsWithoutFollowthrough}
                tone={commercialEvidence.recommendationsWithoutFollowthrough > 0 ? "warning" : "default"}
              />
              <MetricCard label="Malformed records skipped" value={commercialEvidence.malformedFollowThroughCount} />
            </div>
            {commercialEvidence.diagnostics.length > 0 && (
              <Alert tone="info" className="mt-4" title="Data-quality signals">
                {commercialEvidence.diagnostics.length} recommendation{commercialEvidence.diagnostics.length === 1 ? " has" : "s have"} a follow-through
                record worth a second look (e.g. a recorded result that doesn&rsquo;t match the lead&rsquo;s current status). Nothing was changed
                automatically.
              </Alert>
            )}
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
              followthroughRecorded={commercialEvidence.followthroughRecorded}
              customerResponsesObserved={commercialEvidence.customerResponsesObserved}
              ownerReportedDispositions={commercialEvidence.ownerReportedWon + commercialEvidence.ownerReportedLost + commercialEvidence.ownerReportedPending}
            />
          </section>
        </>
      )}
    </div>
  );
}
