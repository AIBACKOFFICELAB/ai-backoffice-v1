import { createHash } from "crypto";
import { AgentStore, SupabaseAgentStore } from "../agentStore";
import { AgentRunStore, SupabaseAgentRunStore } from "../runStore";
import { AiGateway, ai as defaultGateway } from "@/lib/ai/gateway";
import { AiGatewayError } from "@/lib/ai/types";
import { emitEvent } from "@/lib/events/service";
import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { isEstimateClosingShadowEnabled } from "./featureFlag";
import { checkEstimateEligibility } from "./eligibility";
import { validateEstimateClosingModelOutput } from "./modelContract";
import { buildEstimateClosingPrompt, ESTIMATE_CLOSING_SYSTEM_PROMPT } from "./prompt";
import { ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "./mode";
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext, EstimateClosingRecommendation } from "./types";

/**
 * P1A — Estimate Closing Agent, Shadow Mode. See AGENTIC_ROADMAP.md and
 * the P1 Sprint 1 directive's "Hard Safety Boundary — Shadow Means Shadow"
 * section.
 *
 * SHADOW MODE INVARIANT, enforced structurally, not just by convention:
 * there is no `toolPlan` parameter anywhere in this file's public surface.
 * This module never imports lib/agents/toolRegistry.ts or
 * lib/agents/runtime.ts's tool-call loop, never creates a tool_calls row,
 * and never creates an approvals row — there is no code path here through
 * which any of those could happen. The only side effects a successful run
 * has are: one agent_runs row, one model_invocations row (via the
 * gateway), and one business_events row carrying a privacy-safe,
 * structured recommendation. Nothing customer-facing, nothing that
 * mutates a lead or an estimate.
 */

export type EstimateClosingShadowDeps = {
  agentStore?: AgentStore;
  runStore?: AgentRunStore;
  eventStore?: BusinessEventStore;
  gateway?: AiGateway;
  /** Injectable for tests — defaults to the real, env-gated check. */
  isEnabled?: () => boolean;
};

function resolveDeps(deps: EstimateClosingShadowDeps) {
  return {
    agentStore: deps.agentStore ?? new SupabaseAgentStore(),
    runStore: deps.runStore ?? new SupabaseAgentRunStore(),
    eventStore: deps.eventStore ?? new SupabaseBusinessEventStore(),
    gateway: deps.gateway ?? defaultGateway,
    isEnabled: deps.isEnabled ?? isEstimateClosingShadowEnabled,
  };
}

export type EstimateClosingShadowSkipReason =
  | "feature_disabled"
  | "already_processed"
  | "agent_missing"
  | "agent_inactive"
  | "not_eligible";

export type EstimateClosingShadowOutcome =
  | { status: "skipped"; reason: EstimateClosingShadowSkipReason }
  | { status: "succeeded"; agentRunId: string; recommendationEventId: string; recommendation: EstimateClosingRecommendation }
  | { status: "failed"; agentRunId: string; failureReason: string };

/** Same privacy-safe fingerprint pattern as
 * lib/agents/runtime.ts::fingerprintModelOutput — the rationale text lives
 * only in memory for the duration of this call; never persisted. */
function fingerprintText(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `sha256:${digest};chars:${text.length}`;
}

/**
 * SHADOW MODE ENTRY POINT — reasons about ONE already-identified stalled
 * estimate and, on success, emits a privacy-safe recommendation event.
 * Never called from a page render (see stalledScan.ts, the only intended
 * caller) — `triggerEventId` should be the id of the `estimate.stalled`
 * event that identified this opportunity, so the recommendation event's
 * `causationId` chains back to it.
 *
 * Gates, ALL of which must pass before any model call happens — any one
 * failing is a safe, silent no-op (no agent_run, no model call, no event):
 *   1. isEstimateClosingShadowEnabled() (or the injected override) — the
 *      production kill switch (featureFlag.ts), independent of the agent
 *      row's own status.
 *   2. No run triggered by this EXACT event has already succeeded
 *      (runStore.hasSucceededRun) — the retry-safety check. `triggerEventId`
 *      carries a PERMANENT idempotency key at the event layer
 *      (stalledScan.ts's estimate.stalled events can never be re-emitted for
 *      the same estimate), so gating retries on event-emission dedup alone
 *      would mean a transient gateway failure, or a tenant whose agent
 *      wasn't yet active, permanently loses its one chance at a
 *      recommendation. Gating on "has this actually succeeded" instead
 *      means a later sweep safely retries anything that hasn't — see
 *      stalledScan.ts's ShadowSweepResult, which now attempts every
 *      currently-stalled candidate, not just newly-emitted ones.
 *   3. A tenant `estimate_closing` agent row exists AND its status is
 *      'active' — re-verified here, never assumed from the caller, the
 *      same discipline lib/agents/permissions.ts applies to every other
 *      agent invocation in this codebase.
 *   4. The estimate is still genuinely eligible AT CALL TIME (re-checked
 *      via eligibility.ts, not trusted from whatever triggered this call —
 *      time may have passed, or the sequence could have gotten a reply
 *      since the caller last checked).
 */
export async function triggerEstimateClosingShadow(
  tenantId: string,
  triggerEventId: string,
  lead: EstimateClosingLeadContext,
  sequence: EstimateFollowupSequenceContext,
  deps: EstimateClosingShadowDeps = {}
): Promise<EstimateClosingShadowOutcome> {
  const { agentStore, runStore, eventStore, gateway, isEnabled } = resolveDeps(deps);

  if (!isEnabled()) {
    return { status: "skipped", reason: "feature_disabled" };
  }

  if (await runStore.hasSucceededRun(tenantId, triggerEventId)) {
    return { status: "skipped", reason: "already_processed" };
  }

  const agent = await agentStore.findByBuiltinType(tenantId, "estimate_closing");
  if (!agent) {
    return { status: "skipped", reason: "agent_missing" };
  }
  if (agent.status !== "active") {
    return { status: "skipped", reason: "agent_inactive" };
  }

  const eligibility = checkEstimateEligibility({ tenantId, lead, sequence });
  if (!eligibility.eligible) {
    return { status: "skipped", reason: "not_eligible" };
  }

  const agentRun = await runStore.create({
    tenantId,
    agentId: agent.id,
    triggerEventId,
    workflowId: ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID,
    // Pointer, not raw context (AGENT_SECURITY.md's "Sensitive data"
    // section: agent_runs.input_context_ref is a pointer, never a copy of
    // the customer record).
    inputContextRef: `lead:${lead.id}`,
  });
  await runStore.update(tenantId, agentRun.id, { status: "running", startedAt: new Date().toISOString() });

  const prompt = buildEstimateClosingPrompt(lead, sequence);

  try {
    const response = await gateway.generateStructured({
      tenantId,
      agentRunId: agentRun.id,
      workflowId: ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID,
      prompt,
      system: ESTIMATE_CLOSING_SYSTEM_PROMPT,
      complexity: "medium",
      // No customer PII crosses the model boundary at all (see prompt.ts) —
      // "internal", not "customer_pii".
      privacyClass: "internal",
      validate: validateEstimateClosingModelOutput,
    });

    const recommendation: EstimateClosingRecommendation = {
      recommendation: response.value.recommendation,
      confidence: response.value.confidence,
      reasonCodes: response.value.reasonCodes,
      suggestedChannel: response.value.suggestedChannel,
      suggestedTiming: response.value.suggestedTiming,
      // Deterministic, from the lead's own stored amount — never trusted
      // from model output. Eligibility already guarantees this is > 0.
      // See types.ts's doc comment on EstimateClosingModelOutput.
      opportunityValue: lead.estimateAmount,
      rationaleLength: response.value.rationale.length,
    };

    await runStore.update(tenantId, agentRun.id, {
      status: "succeeded",
      completedAt: new Date().toISOString(),
      outputSummary: fingerprintText(response.value.rationale),
      modelStrategy: { provider: response.provider, model: response.model, taskType: "generate" },
    });

    const { event } = await emitEvent(
      {
        tenantId,
        eventType: "estimate.closing_recommendation_generated",
        actorType: "agent",
        actorId: agent.id,
        entityType: "lead",
        entityId: lead.id,
        causationId: triggerEventId,
        payload: { ...recommendation, agentRunId: agentRun.id, sequenceId: sequence.id },
      },
      eventStore
    );

    return { status: "succeeded", agentRunId: agentRun.id, recommendationEventId: event.id, recommendation };
  } catch (error) {
    // Never the raw provider error text — AiGatewayError's own message is
    // already a fixed, category-specific, sanitized string (see
    // lib/ai/gateway.ts::normalizeProviderError); anything else thrown
    // here (e.g. a store failure) is reduced to its category-less generic
    // form rather than risking an unsanitized message reaching a durable
    // column.
    const failureReason =
      error instanceof AiGatewayError ? `model gateway failed: ${error.category}` : "model gateway failed: unexpected error";
    await runStore.update(tenantId, agentRun.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      failureReason,
    });
    return { status: "failed", agentRunId: agentRun.id, failureReason };
  }
}
