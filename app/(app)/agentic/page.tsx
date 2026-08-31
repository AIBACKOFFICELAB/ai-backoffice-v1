export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { Bot, CircleCheck, Target, Sparkles, ShieldAlert } from "lucide-react";
import { getTenantContext } from "@/lib/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { AIStatusBadge } from "@/components/ui/AIStatusBadge";
import { Alert } from "@/components/ui/Alert";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import { SupabaseAgentStore } from "@/lib/agents/agentStore";
import { SupabaseAgentRunStore } from "@/lib/agents/runStore";
import { SupabaseToolCallStore } from "@/lib/agents/toolCallStore";
import { SupabaseApprovalStore } from "@/lib/approvals/store";
import { SupabaseOutcomeStore } from "@/lib/outcomes/store";
import { modeForRunWorkflow, ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "@/lib/agents/estimateClosing/mode";
import { isEstimateClosingShadowEnabled } from "@/lib/agents/estimateClosing/featureFlag";
import { listEstimateClosingRecommendations, summarizeEstimateClosingRecommendations } from "@/lib/agents/estimateClosing/recommendationReadModel";
import { resolveEstimateClosingAgentStatus } from "@/lib/agents/estimateClosing/status";
import { ShadowRecommendationCard } from "@/components/ai/ShadowRecommendationCard";
import { MetricCard } from "@/components/dashboard/MetricCard";

/** Bounded — a small, scannable set of recent recommendation cards, not the
 * full read-model window. Matches the same discipline the dashboard's own
 * DASHBOARD_RECOMMENDATION_CARD_LIMIT applies. */
const AGENTIC_RECOMMENDATION_CARD_LIMIT = 6;

const RUN_STATUS_TONE: Record<string, string> = {
  succeeded: "bg-success-50 text-success-700",
  failed: "bg-danger-50 text-danger-700",
  denied: "bg-danger-50 text-danger-700",
  partial: "bg-warning-50 text-warning-700",
  awaiting_approval: "bg-warning-50 text-warning-700",
  running: "bg-brand-50 text-brand-700",
  pending: "bg-surface-sunken text-ink-700",
  cancelled: "bg-surface-sunken text-ink-700",
};

/**
 * Founder-safe operational view of the agent runtime (P1 directive §18,
 * evolving the P0 internal-only page). Shows agent / state / mode /
 * timestamp / trigger category / outcome / approval requirement / failure
 * state for each run. Deliberately never shows: raw prompts, raw model
 * responses, provider credentials, or internal policy internals —
 * agent_runs.output_summary is already a privacy-safe fingerprint, not raw
 * text (see AGENT_SECURITY.md), so there is nothing raw to withhold here;
 * this page's own job is presentation, not redaction.
 */
export default async function AgenticActivityPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const [events, agents, agentRuns, approvals, outcomes, recommendationsResult] = await Promise.all([
    new SupabaseBusinessEventStore().listByTenant(tenant.tenantId, { limit: 15 }),
    new SupabaseAgentStore().listByTenant(tenant.tenantId),
    new SupabaseAgentRunStore().listByTenant(tenant.tenantId, { limit: 10 }),
    new SupabaseApprovalStore().listByTenant(tenant.tenantId),
    new SupabaseOutcomeStore().listByTenant(tenant.tenantId, { limit: 10 }),
    // Dedicated, validated read model (P1 Sprint 2) — see
    // lib/agents/estimateClosing/recommendationReadModel.ts.
    listEstimateClosingRecommendations(tenant.tenantId),
  ]);

  const toolCallStore = new SupabaseToolCallStore();
  const runsWithToolCalls = await Promise.all(
    agentRuns.map(async (run) => ({ run, toolCalls: await toolCallStore.listByAgentRun(tenant.tenantId, run.id) }))
  );

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const pendingApprovals = approvals.filter((a) => a.status === "pending");

  // Estimate Closing — Shadow Mode: dedicated status + metrics for the
  // section below, built the same honest way revenueCommandCenter.ts does.
  const estimateClosingAgentStatus = resolveEstimateClosingAgentStatus(agents);
  const estimateClosingShadowEnabled = isEstimateClosingShadowEnabled();
  const estimateClosingSummary = summarizeEstimateClosingRecommendations(recommendationsResult.recommendations);
  const estimateClosingFailures = agentRuns.filter((run) => run.workflowId === ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID && run.status === "failed");

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Activity"
        description="Every agent run, tool call, approval, and recorded outcome for this account — governed and auditable."
      />

      {pendingApprovals.length > 0 && (
        <Alert tone="warning" title={`${pendingApprovals.length} approval${pendingApprovals.length === 1 ? "" : "s"} waiting on you`}>
          An agent has drafted an action that requires your sign-off before it can happen — see Approvals below.
        </Alert>
      )}

      {/* Estimate Closing — Shadow Mode */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-ink-900">Estimate Closing — Shadow Mode</h2>
              <p className="mt-0.5 text-sm text-ink-500">
                {estimateClosingAgentStatus === "not_registered"
                  ? "Not yet configured for this account."
                  : "Nothing is sent to customers. Every recommendation below is observation only."}
              </p>
            </div>
            {estimateClosingAgentStatus === "active" && estimateClosingShadowEnabled && <AIStatusBadge mode="shadow" />}
          </div>
        </CardHeader>
        <CardBody>
          {estimateClosingAgentStatus === "not_registered" ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="No agent registered"
              description="Estimate Closing is available but has not been configured for this account."
            />
          ) : estimateClosingAgentStatus === "inactive" ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="Registered, not running"
              description="Estimate Closing is configured but not running."
            />
          ) : !estimateClosingShadowEnabled ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="Shadow disabled"
              description="Shadow intelligence is not currently enabled."
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Recommendations generated" value={estimateClosingSummary.estimatesAnalyzed} icon={<Bot className="h-4 w-4" />} />
                <MetricCard
                  label="Opportunity value analyzed"
                  value={`$${estimateClosingSummary.opportunityValueAnalyzed.toLocaleString()}`}
                  helpText="What AI noticed — not revenue recovered"
                  icon={<Target className="h-4 w-4" />}
                />
                <MetricCard
                  label="Recommendation breakdown"
                  value={`${estimateClosingSummary.followUpCount} / ${estimateClosingSummary.waitCount} / ${estimateClosingSummary.ownerReviewCount}`}
                  helpText="Follow up / Wait / Owner review"
                  icon={<Sparkles className="h-4 w-4" />}
                />
                <MetricCard
                  label="Latest recommendation"
                  value={estimateClosingSummary.latestRecommendationAt ?? "—"}
                  icon={<Bot className="h-4 w-4" />}
                />
              </div>

              {estimateClosingFailures.length > 0 && (
                <Alert tone="warning" className="mt-4" title={`${estimateClosingFailures.length} recent shadow run${estimateClosingFailures.length === 1 ? "" : "s"} failed`}>
                  {estimateClosingFailures[0].failureReason ?? "A shadow reasoning run did not complete."} No customer action was attempted or affected.
                </Alert>
              )}

              <div className="mt-4">
                {recommendationsResult.recommendations.length === 0 ? (
                  <EmptyState
                    icon={<Bot className="h-8 w-8" />}
                    title="No recommendations yet"
                    description="No stalled estimates have produced a recommendation yet."
                  />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {recommendationsResult.recommendations.slice(0, AGENTIC_RECOMMENDATION_CARD_LIMIT).map((rec) => (
                      <ShadowRecommendationCard
                        key={rec.recommendationEventId}
                        recommendation={{
                          recommendation: rec.recommendation,
                          confidence: rec.confidence,
                          reasonCodes: rec.reasonCodes,
                          suggestedChannel: rec.suggestedChannel,
                          suggestedTiming: rec.suggestedTiming,
                          opportunityValue: rec.opportunityValue,
                          rationaleLength: 0,
                        }}
                        serviceType="Estimate"
                        occurredAt={rec.occurredAt}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Agents ({agents.length})</h2>
        </CardHeader>
        <CardBody>
          {agents.length === 0 ? (
            <EmptyState icon={<Bot className="h-8 w-8" />} title="No agents registered yet" description="Agents will appear here once configured for this account." />
          ) : (
            <ul className="divide-y divide-surface-border">
              {agents.map((agent) => (
                <li key={agent.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium text-ink-900">{agent.name}</p>
                    <p className="text-ink-500">{agent.agentType}</p>
                  </div>
                  <span className="rounded-pill bg-surface-sunken px-2.5 py-1 text-xs font-semibold text-ink-700">{agent.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Recent agent runs ({runsWithToolCalls.length})</h2>
        </CardHeader>
        <CardBody>
          {runsWithToolCalls.length === 0 ? (
            <EmptyState icon={<CircleCheck className="h-8 w-8" />} title="No agent runs yet" description="Agent runs appear here once an agent has been invoked." />
          ) : (
            <div className="space-y-4">
              {runsWithToolCalls.map(({ run, toolCalls }) => {
                const mode = modeForRunWorkflow(run.workflowId);
                return (
                  <div key={run.id} className="rounded-card border border-surface-border p-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-ink-900">{agentNameById.get(run.agentId) ?? run.agentId}</p>
                      <div className="flex items-center gap-2">
                        <AIStatusBadge mode={mode} />
                        <span className={`rounded-pill px-2.5 py-1 text-xs font-semibold ${RUN_STATUS_TONE[run.status] ?? "bg-surface-sunken text-ink-700"}`}>
                          {run.status}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 text-ink-500">
                      trigger: {run.workflowId ?? "manual"} &bull; started {run.startedAt ?? "—"} &bull; completed {run.completedAt ?? "—"}
                    </p>
                    {run.failureReason && <p className="mt-2 text-danger-600">Failure: {run.failureReason}</p>}
                    {mode === "shadow" && run.status === "succeeded" && (
                      <p className="mt-2 text-ink-500">No action taken — Shadow Mode. Nothing was sent to the customer.</p>
                    )}
                    {toolCalls.length > 0 && (
                      <ul className="mt-3 space-y-1.5 border-t border-surface-border pt-3">
                        {toolCalls.map((tc) => (
                          <li key={tc.id} className="flex items-center justify-between gap-2 text-xs text-ink-500">
                            <span>
                              {tc.toolName}.{tc.action} {tc.requiresApproval ? "(approval required)" : ""}
                            </span>
                            <span className="font-semibold text-ink-700">{tc.status}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Approvals ({approvals.length})</h2>
        </CardHeader>
        <CardBody>
          {approvals.length === 0 ? (
            <EmptyState title="No approval requests" description="Actions an agent needs sign-off for will appear here." />
          ) : (
            <ul className="divide-y divide-surface-border">
              {approvals.map((approval) => (
                <li key={approval.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium text-ink-900">{approval.requestedAction}</p>
                    <p className="text-ink-500">
                      risk: {approval.riskLevel} &bull; requested {approval.createdAt}
                    </p>
                  </div>
                  <span className={`rounded-pill px-2.5 py-1 text-xs font-semibold ${approval.status === "pending" ? "bg-warning-50 text-warning-700" : "bg-surface-sunken text-ink-700"}`}>
                    {approval.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Recorded outcomes ({outcomes.length})</h2>
        </CardHeader>
        <CardBody>
          {outcomes.length === 0 ? (
            <EmptyState title="No outcomes recorded yet" description="Business outcomes attributed to a workflow or agent run appear here." />
          ) : (
            <ul className="divide-y divide-surface-border">
              {outcomes.map((outcome) => (
                <li key={outcome.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium text-ink-900">{outcome.outcomeType}</p>
                    <p className="text-ink-500">
                      {outcome.attributionConfidence} &bull; {outcome.occurredAt}
                    </p>
                  </div>
                  {outcome.outcomeValue != null && (
                    <span className="font-semibold text-ink-900">
                      {outcome.currency} {outcome.outcomeValue.toFixed(2)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Recent business events ({events.length})</h2>
        </CardHeader>
        <CardBody>
          {events.length === 0 ? (
            <EmptyState title="No events yet" description="Events emitted by modules and the agent runtime appear here." />
          ) : (
            <ul className="divide-y divide-surface-border">
              {events.map((event) => (
                <li key={event.id} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink-900">{event.eventType}</span>
                    <span className="text-xs text-ink-500">{event.occurredAt}</span>
                  </div>
                  <p className="text-ink-500">
                    {event.actorType}
                    {event.actorId ? ` (${event.actorId})` : ""}
                    {event.entityType ? ` → ${event.entityType}:${event.entityId}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
