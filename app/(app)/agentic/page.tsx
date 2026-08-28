export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import { SupabaseAgentStore } from "@/lib/agents/agentStore";
import { SupabaseAgentRunStore } from "@/lib/agents/runStore";
import { SupabaseToolCallStore } from "@/lib/agents/toolCallStore";
import { SupabaseApprovalStore } from "@/lib/approvals/store";
import { SupabaseOutcomeStore } from "@/lib/outcomes/store";

/**
 * Internal observability surface for the P0 agentic foundation (see P0
 * directive §11 "P0 User Experience": protected internal visibility into
 * events/agent runs/model usage/tool calls/approvals/outcomes, deliberately
 * not part of the polished customer-facing product). Read-only, plain
 * presentation — this is diagnostic tooling, not a shipped feature.
 */
export default async function AgenticActivityPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const [events, agents, agentRuns, approvals, outcomes] = await Promise.all([
    new SupabaseBusinessEventStore().listByTenant(tenant.tenantId, { limit: 15 }),
    new SupabaseAgentStore().listByTenant(tenant.tenantId),
    new SupabaseAgentRunStore().listByTenant(tenant.tenantId, { limit: 10 }),
    new SupabaseApprovalStore().listByTenant(tenant.tenantId),
    new SupabaseOutcomeStore().listByTenant(tenant.tenantId, { limit: 10 }),
  ]);

  const toolCallStore = new SupabaseToolCallStore();
  const runsWithToolCalls = await Promise.all(
    agentRuns.map(async (run) => ({ run, toolCalls: await toolCallStore.listByAgentRun(tenant.tenantId, run.id) }))
  );

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agentic Activity"
        description="Internal view of the P0 agent runtime: business events, agent runs, tool calls, approvals, and recorded outcomes for this tenant."
      />

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-ink-900">Agents ({agents.length})</h2>
        </CardHeader>
        <CardBody>
          {agents.length === 0 ? (
            <EmptyState title="No agents registered yet" description="Run the seed script (lib/agents/seed.ts) to create the P0 dev/test agent." />
          ) : (
            <ul className="divide-y divide-surface-border">
              {agents.map((agent) => (
                <li key={agent.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium text-ink-900">{agent.name}</p>
                    <p className="text-ink-500">
                      {agent.agentType} &bull; tools: {agent.allowedTools.join(", ") || "none"}
                    </p>
                  </div>
                  <span className="rounded-pill bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-700">{agent.status}</span>
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
            <EmptyState title="No agent runs yet" description="Agent runs appear here once an agent has been invoked." />
          ) : (
            <div className="space-y-4">
              {runsWithToolCalls.map(({ run, toolCalls }) => (
                <div key={run.id} className="rounded-card border border-surface-border p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-ink-900">
                      {agentNameById.get(run.agentId) ?? run.agentId} {run.workflowId ? `— ${run.workflowId}` : ""}
                    </p>
                    <span className="rounded-pill bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-700">{run.status}</span>
                  </div>
                  <p className="mt-1 text-ink-500">
                    started {run.startedAt ?? "—"} &bull; completed {run.completedAt ?? "—"}
                  </p>
                  {run.outputSummary && <p className="mt-2 text-ink-700">{run.outputSummary}</p>}
                  {run.failureReason && <p className="mt-2 text-red-600">Failure: {run.failureReason}</p>}
                  {toolCalls.length > 0 && (
                    <ul className="mt-3 space-y-1.5 border-t border-surface-border pt-3">
                      {toolCalls.map((tc) => (
                        <li key={tc.id} className="flex items-center justify-between gap-2 text-xs text-ink-500">
                          <span>
                            {tc.toolName}.{tc.action}
                          </span>
                          <span className="font-semibold text-ink-700">{tc.status}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
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
                  <span className="rounded-pill bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-700">{approval.status}</span>
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
