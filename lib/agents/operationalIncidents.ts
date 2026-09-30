import { AgentRun } from "./runStore";

/**
 * P1 Sprint 7 §9/§10 — active-vs-historical incident classification.
 *
 * PROBLEM THIS SOLVES: the dashboard's "Needs your attention" agent-failure
 * card, and the equivalent list on /agentic, have always shown every failed
 * agent_runs row in the recent window with no regard for whether a LATER
 * run for the exact same subject already succeeded. A tenant whose Sep 21
 * and Sep 22 Shadow attempts failed on a since-fixed configuration problem,
 * then succeeded on Sep 23, still saw both stale failures listed as if they
 * were unresolved problems needing action today.
 *
 * This module never deletes, mutates, or hides a failed run's own record —
 * `agent_runs` rows are immutable audit history (§9: "The failed agent runs
 * MUST remain immutable"). It is a pure, read-only PRESENTATION classifier:
 * given a set of runs, it decides which failures are still ACTIVE (need
 * attention now) vs. RESOLVED (a later run for the same subject already
 * succeeded, so they are historical/superseded) — see §18: displayed as
 * "Historical failure" / "Resolved by later successful run".
 *
 * SUBJECT IDENTITY: two runs are "the same logical workflow/subject" only
 * when they share `agentId`, `workflowId`, AND `triggerEventId`. For
 * Estimate Closing, `triggerEventId` is the id of the one-time,
 * non-re-emittable `estimate.stalled` event for a specific estimate (see
 * stalledScan.ts::buildStalledIdempotencyKey) — every scan attempt against
 * the same estimate reuses that same id, so grouping on it correctly
 * correlates repeated attempts against ONE estimate without ever needing a
 * hardcoded date or id (§10: "Generalize the rule safely... A newer failure
 * after a success must become active again" — handled naturally below,
 * since only a success from a STRICTLY LATER attempt can resolve a given
 * failure). `agentId` is always included (not just a fallback) so that two
 * different agents which both happen to omit `workflowId` and share a
 * `triggerEventId` — the generic agent-runtime API permits exactly this —
 * are never merged into one subject; a success from one agent must never
 * mark another agent's failure for the same event as historical (Codex
 * review, PR #30). A run with no `triggerEventId` has no safe entity
 * context to correlate on and is treated as its own singleton subject — it
 * is NEVER merged with another triggerEventId-less run just because both
 * happen to be missing one (§29 tests E/F: unrelated subjects must never
 * resolve each other).
 *
 * RETRY ORDER: "later" is determined by `createdAt` (when the attempt was
 * launched), never by `completedAt`. Run creation and the terminal-status
 * check are not atomic, so an older, slower attempt can finish (and fail)
 * AFTER a newer retry has already succeeded, or an older attempt can
 * succeed late, after a newer attempt has already failed — completion-time
 * ordering would misclassify either case (Codex review, PR #30).
 * `completedAt` is used only for DISPLAY of when the resolving run actually
 * finished, never to decide which attempt is logically later.
 *
 * Only two states are ever produced at runtime. "Historical" (§18's exact
 * wording) is the DISPLAY category for `resolved_by_later_success` — there
 * is no independently meaningful third runtime state: a failure is either
 * still unresolved (active) or proven resolved by a later attempt's success
 * for the same subject (resolved_by_later_success, shown as "Historical
 * failure").
 */
export type OperationalIncidentState = "active" | "resolved_by_later_success";

export type ClassifiedFailedRun = {
  runId: string;
  state: OperationalIncidentState;
  /** The id/occurredAt of the later successful run that resolved this
   * failure — non-null exactly when state === "resolved_by_later_success".
   * Lets the UI show "Resolved by later successful run · Sep 23, 2026". */
  resolvedByRunId: string | null;
  resolvedByOccurredAt: string | null;
};

/** Display-only: when this run actually reached its terminal state. Never
 * used to decide retry order — see the module doc comment's "RETRY ORDER". */
function runTimestamp(run: AgentRun): string {
  return run.completedAt ?? run.startedAt ?? run.createdAt;
}

function subjectKey(run: AgentRun): string {
  if (run.triggerEventId) return `${run.agentId}::${run.workflowId ?? "__no_workflow__"}::${run.triggerEventId}`;
  return `__no_trigger__::${run.id}`;
}

/**
 * Pure. Classifies only the FAILED runs in `runs` (every other status is
 * irrelevant to incident classification and is simply not present in the
 * returned map — look up by run id, `undefined` means "not a failed run").
 * `runs` may be any bounded window; a success that itself falls outside the
 * window cannot resolve a failure this function is given, which is the
 * conservative, correct behavior for a bounded read (never assume a
 * resolution the caller hasn't actually fetched evidence for).
 */
export function classifyAgentRunIncidents(runs: AgentRun[]): Map<string, ClassifiedFailedRun> {
  const bySubject = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const key = subjectKey(run);
    const existing = bySubject.get(key);
    if (existing) existing.push(run);
    else bySubject.set(key, [run]);
  }

  const result = new Map<string, ClassifiedFailedRun>();
  for (const run of runs) {
    if (run.status !== "failed") continue;
    const subject = bySubject.get(subjectKey(run)) ?? [];

    let resolver: AgentRun | null = null;
    for (const candidate of subject) {
      if (candidate.status !== "succeeded") continue;
      if (candidate.createdAt <= run.createdAt) continue; // only a run from a STRICTLY LATER attempt resolves a failure
      if (!resolver || candidate.createdAt < resolver.createdAt) resolver = candidate;
    }

    result.set(run.id, {
      runId: run.id,
      state: resolver ? "resolved_by_later_success" : "active",
      resolvedByRunId: resolver?.id ?? null,
      resolvedByOccurredAt: resolver ? runTimestamp(resolver) : null,
    });
  }
  return result;
}

/** Convenience predicate for callers that only care about the active/not
 * distinction (e.g. the dashboard attention card). */
export function isActiveFailedRun(runId: string, classified: Map<string, ClassifiedFailedRun>): boolean {
  return classified.get(runId)?.state === "active";
}
