export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import {
  Wallet,
  AlertTriangle,
  Clock,
  UserPlus,
  Trophy,
  Sparkles,
  Bot,
  PhoneMissed,
  CircleCheck,
  ShieldAlert,
  Target,
} from "lucide-react";
import { getTenantContext } from "@/lib/tenant";
import { buildRevenueCommandCenterData, AttentionItemKind } from "@/lib/dashboard/revenueCommandCenter";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { ActionCard, ActionCardTone } from "@/components/dashboard/ActionCard";
import { ActivityItem } from "@/components/dashboard/ActivityItem";
import { ShadowRecommendationCard } from "@/components/ai/ShadowRecommendationCard";
import { AIStatusBadge } from "@/components/ui/AIStatusBadge";

/** Bounded — the P1 Sprint 2 directive requires "a small bounded number of
 * the highest-value/recent actionable recommendations," not the entire
 * (already-bounded-at-the-read-model-level) window. */
const DASHBOARD_RECOMMENDATION_CARD_LIMIT = 4;

const ATTENTION_TONE: Record<AttentionItemKind, ActionCardTone> = {
  emergency_lead: "danger",
  agent_failure: "danger",
  overdue_follow_up: "warning",
  stalled_estimate: "warning",
  pending_approval: "info",
};

const ATTENTION_LABEL: Record<AttentionItemKind, string> = {
  emergency_lead: "Emergency lead",
  overdue_follow_up: "Follow-up overdue",
  stalled_estimate: "Stalled estimate",
  pending_approval: "Approval needed",
  agent_failure: "Agent issue",
};

export default async function DashboardPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const data = await buildRevenueCommandCenterData(tenant.tenantId, tenant.tenantName);
  const { metrics } = data;

  const attentionCount = data.attentionItems.length;
  const operatingStateLine =
    attentionCount === 0
      ? "Everything's on track — no opportunities need attention right now."
      : `${attentionCount} ${attentionCount === 1 ? "opportunity needs" : "opportunities need"} attention`;

  return (
    <div className="space-y-8">
      {/* A. Executive header */}
      <section className="rounded-card bg-brand-950 p-7 text-white shadow-raised">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-300">Revenue Command Center</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{tenant.tenantName}</h1>
        <p className="mt-2 text-brand-200">{operatingStateLine}</p>
      </section>

      {/* B. Primary revenue metrics */}
      <section>
        <h2 className="text-xl font-bold text-ink-900">Revenue</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard label="Revenue Pipeline" value={`$${metrics.revenuePipeline.toLocaleString()}`} helpText="Open leads not yet won or closed" icon={<Wallet className="h-4 w-4" />} href="/lead-inbox" />
          <MetricCard
            label="At-Risk Estimate Value"
            value={`$${metrics.atRiskEstimateValue.toLocaleString()}`}
            helpText="Sent estimates awaiting a decision"
            icon={<AlertTriangle className="h-4 w-4" />}
            href="/follow-ups"
            tone={metrics.atRiskEstimateValue > 0 ? "warning" : "default"}
          />
          <MetricCard label="Follow-Ups Due" value={metrics.followUpsDue} helpText="Leads needing a callback today" icon={<Clock className="h-4 w-4" />} href="/follow-ups" />
          <MetricCard label="New Leads" value={metrics.newLeads} helpText="Not yet contacted" icon={<UserPlus className="h-4 w-4" />} href="/lead-inbox" />
          <MetricCard label="Jobs Won" value={metrics.jobsWon} helpText="Closed and won" icon={<Trophy className="h-4 w-4" />} />
          <MetricCard
            label="Direct Revenue Recovered by AI"
            value={`$${data.directRevenueRecoveredUsd.toLocaleString()}`}
            helpText={data.directRevenueRecoveredUsd > 0 ? "Directly attributed outcomes only" : "No directly-attributed outcomes recorded yet"}
            icon={<Sparkles className="h-4 w-4" />}
            tone={data.directRevenueRecoveredUsd > 0 ? "success" : "default"}
          />
        </div>
      </section>

      {/* C. Attention / opportunity section */}
      <section>
        <h2 className="text-xl font-bold text-ink-900">Needs your attention</h2>
        <p className="text-sm text-ink-500">Emergency leads, overdue follow-ups, stalled estimates, and anything waiting on you.</p>
        <div className="mt-4">
          {data.attentionItems.length === 0 ? (
            <EmptyState
              icon={<CircleCheck className="h-8 w-8" />}
              title="Nothing needs attention right now"
              description="Emergency leads, overdue follow-ups, stalled estimates, and pending approvals will show up here as they come up."
            />
          ) : (
            <div className="grid gap-3">
              {data.attentionItems.slice(0, 8).map((item, index) => (
                <ActionCard
                  key={`${item.kind}-${item.href}-${index}`}
                  tone={ATTENTION_TONE[item.kind]}
                  title={item.title}
                  description={item.description}
                  value={item.value}
                  href={item.href}
                  meta={<span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{ATTENTION_LABEL[item.kind]}</span>}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* D. Estimate Closing — Shadow Insights */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-ink-900">Estimate Closing — Shadow Insights</h2>
            <p className="text-sm text-ink-500">
              {data.estimateClosingAgentStatus === "active" && data.estimateClosingShadowEnabled
                ? "The Estimate Closing Agent is analyzing stalled estimates in Shadow Mode. Nothing is sent to customers."
                : "AI observation only — no customer action is ever taken by this agent, active or not."}
            </p>
          </div>
          {data.estimateClosingAgentStatus === "active" && data.estimateClosingShadowEnabled && <AIStatusBadge mode="shadow" />}
        </div>

        <div className="mt-4">
          {data.estimateClosingAgentStatus === "not_registered" ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="No agent registered"
              description="Estimate Closing is available but has not been configured for this account."
            />
          ) : data.estimateClosingAgentStatus === "inactive" ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="Registered, not running"
              description="Estimate Closing is configured but not running."
            />
          ) : !data.estimateClosingShadowEnabled ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="Shadow disabled"
              description="Shadow intelligence is not currently enabled."
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Estimates analyzed by AI" value={data.estimateClosingSummary.estimatesAnalyzed} icon={<Bot className="h-4 w-4" />} />
                <MetricCard
                  label="AI opportunity value analyzed"
                  value={`$${data.estimateClosingSummary.opportunityValueAnalyzed.toLocaleString()}`}
                  helpText="What AI noticed is at stake — not revenue recovered"
                  icon={<Target className="h-4 w-4" />}
                />
                <MetricCard label="Follow-up recommendations" value={data.estimateClosingSummary.followUpCount} icon={<Sparkles className="h-4 w-4" />} />
                <MetricCard label="Owner-review recommendations" value={data.estimateClosingSummary.ownerReviewCount} icon={<ShieldAlert className="h-4 w-4" />} />
              </div>

              <div className="mt-4">
                {data.shadowRecommendations.length === 0 ? (
                  <EmptyState
                    icon={<Bot className="h-8 w-8" />}
                    title="No recommendations yet"
                    description="No stalled estimates have produced a recommendation yet."
                  />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {data.shadowRecommendations.slice(0, DASHBOARD_RECOMMENDATION_CARD_LIMIT).map((rec) => (
                      <ShadowRecommendationCard
                        key={rec.eventId}
                        recommendation={rec.recommendation}
                        serviceType={rec.customerName ? `${rec.customerName} — ${rec.serviceType}` : rec.serviceType}
                        occurredAt={rec.occurredAt}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <Card className="mt-4">
          <CardHeader>
            <h3 className="font-semibold text-ink-900">Recent activity</h3>
          </CardHeader>
          <CardBody>
            {data.recentActivity.length === 0 ? (
              <EmptyState
                icon={<Bot className="h-8 w-8" />}
                title="No AI activity yet"
                description="Agent runs will appear here as soon as an agent is active for this account."
              />
            ) : (
              <ul className="divide-y divide-surface-border">
                {data.recentActivity.map((item) => (
                  <ActivityItem
                    key={item.id}
                    icon={<Bot className="h-4 w-4" />}
                    title={item.title}
                    description={item.description}
                    timestamp={item.occurredAt}
                    badge={
                      item.status === "failed" ? (
                        <span className="inline-flex items-center gap-1 rounded-pill bg-danger-50 px-2 py-0.5 text-xs font-semibold text-danger-700">
                          <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                          Failed
                        </span>
                      ) : null
                    }
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </section>

      {/* E. Automation / agent performance — existing MCR + Estimate Follow-up analytics, elevated */}
      <section>
        <h2 className="text-xl font-bold text-ink-900">Automation performance</h2>
        <p className="text-sm text-ink-500">Every module execution, measured.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <PhoneMissed className="h-4 w-4 text-ink-400" aria-hidden="true" />
              <p className="text-sm font-semibold text-ink-500">Missed Call Recovery</p>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-ink-900">{data.missedCallAnalytics.totalMissedCalls}</p>
                <p className="text-xs text-ink-400">Missed calls</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-success-600">{data.missedCallAnalytics.recovered}</p>
                <p className="text-xs text-ink-400">Recovered</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-ink-900">{data.missedCallAnalytics.ownerNotified}</p>
                <p className="text-xs text-ink-400">Owner notified</p>
              </div>
              <div>
                <p className={`text-2xl font-bold ${data.missedCallAnalytics.ownerNotificationFailures > 0 ? "text-danger-600" : "text-ink-900"}`}>
                  {data.missedCallAnalytics.ownerNotificationFailures}
                </p>
                <p className="text-xs text-ink-400">Notify failures</p>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-ink-400" aria-hidden="true" />
              <p className="text-sm font-semibold text-ink-500">Estimate Follow-up</p>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-ink-900">{data.estimateFollowupAnalytics.active}</p>
                <p className="text-xs text-ink-400">Active</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-success-600">{data.estimateFollowupAnalytics.replied}</p>
                <p className="text-xs text-ink-400">Replied</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-ink-900">{data.estimateFollowupAnalytics.replyRate}%</p>
                <p className="text-xs text-ink-400">Reply rate</p>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
