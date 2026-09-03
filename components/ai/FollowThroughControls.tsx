"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  FOLLOWTHROUGH_ACTION_TAKEN,
  FOLLOWTHROUGH_ACTION_CHANNEL,
  FOLLOWTHROUGH_CUSTOMER_RESPONSE,
  FOLLOWTHROUGH_BUSINESS_DISPOSITION,
  ACTION_TAKEN_LABELS,
  ACTION_CHANNEL_LABELS,
  CUSTOMER_RESPONSE_LABELS,
  BUSINESS_DISPOSITION_LABELS,
  FollowThroughActionTaken,
  FollowThroughActionChannel,
  FollowThroughCustomerResponse,
  FollowThroughBusinessDisposition,
  EstimateClosingRecommendationFollowThrough,
} from "@/lib/agents/estimateClosing/followThroughTypes";

/**
 * P1 Sprint 6 §14 — "ACTUAL FOLLOW-THROUGH" / "WHAT HAPPENED NEXT" capture
 * form. Imports ONLY from followThroughTypes.ts (dependency-free), never
 * from followThrough.ts/commercialEvidence.ts directly — both transitively
 * import next/headers and would break the client bundle. This is
 * deliberately a DIFFERENT question from ReviewControls.tsx's "was this
 * recommendation good?" — see followThroughTypes.ts's doc comment — and is
 * never presented as "Approve AI"; it is historical evidence capture about
 * what a HUMAN did outside the agent.
 *
 * Pre-fillable and re-submittable: `existingFollowThrough` (when present)
 * seeds the form so the owner can UPDATE their record as the real story
 * develops ("later" today, "yes" + a result next week) — see
 * followThrough.ts's append-only/correction design. Every submission is a
 * new evidence event; the previous one is never lost.
 */
export function FollowThroughControls({
  recommendationEventId,
  existingFollowThrough,
  existingOccurredAt,
}: {
  recommendationEventId: string;
  existingFollowThrough: EstimateClosingRecommendationFollowThrough | null;
  existingOccurredAt: string | null;
}) {
  const router = useRouter();
  const [actionTaken, setActionTaken] = useState<FollowThroughActionTaken | null>(existingFollowThrough?.actionTaken ?? null);
  const [actionChannel, setActionChannel] = useState<FollowThroughActionChannel | null>(existingFollowThrough?.actionChannel ?? null);
  const [customerResponse, setCustomerResponse] = useState<FollowThroughCustomerResponse | null>(existingFollowThrough?.customerResponse ?? null);
  const [businessDisposition, setBusinessDisposition] = useState<FollowThroughBusinessDisposition | null>(
    existingFollowThrough?.businessDisposition ?? null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Captured only once submit() has confirmed all four fields are
  // non-null and valid — a separate, correctly-typed (non-nullable) state
  // from the live form fields above, which stay nullable until chosen.
  const [savedRecord, setSavedRecord] = useState<EstimateClosingRecommendationFollowThrough | null>(null);

  function chooseActionTaken(value: FollowThroughActionTaken) {
    setActionTaken(value);
    // Structural coherence, mirrored client-side from
    // followThrough.ts::validateFollowThroughInput — a channel only ever
    // makes sense once "Yes" is chosen; switching away from "Yes" clears
    // any previously-chosen channel rather than silently keeping it.
    if (value !== "yes") setActionChannel(null);
  }

  async function submit() {
    if (!actionTaken) {
      setError("Choose whether you acted on this recommendation.");
      return;
    }
    if (actionTaken === "yes" && !actionChannel) {
      setError("Choose how you followed up.");
      return;
    }
    if (!customerResponse) {
      setError("Choose whether the customer responded.");
      return;
    }
    if (!businessDisposition) {
      setError("Choose the current business result.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/estimate-closing/recommendations/${encodeURIComponent(recommendationEventId)}/followthrough`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionTaken, actionChannel, customerResponse, businessDisposition }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to record follow-through.");
      setSavedRecord({ recommendationEventId, actionTaken, actionChannel, customerResponse, businessDisposition });
      setSavedAt(data.occurredAt ?? new Date().toISOString());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record follow-through.");
    } finally {
      setSubmitting(false);
    }
  }

  const currentlyRecorded = savedRecord ?? existingFollowThrough;

  return (
    <div className="space-y-4">
      {currentlyRecorded && (
        <p className="text-sm font-medium text-success-700">
          Currently recorded: {ACTION_TAKEN_LABELS[currentlyRecorded.actionTaken]}
          {currentlyRecorded.actionChannel ? ` (${ACTION_CHANNEL_LABELS[currentlyRecorded.actionChannel]})` : ""} &bull; Customer response:{" "}
          {CUSTOMER_RESPONSE_LABELS[currentlyRecorded.customerResponse]} &bull; Result: {BUSINESS_DISPOSITION_LABELS[currentlyRecorded.businessDisposition]}
          {existingOccurredAt && !savedAt ? ` — recorded ${existingOccurredAt}` : ""}
        </p>
      )}

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Did you act on this recommendation?</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FOLLOWTHROUGH_ACTION_TAKEN.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => chooseActionTaken(v)}
              aria-pressed={actionTaken === v}
              className={`min-h-[36px] rounded-pill px-3 text-xs font-semibold ring-1 transition focus-ring ${
                actionTaken === v ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-ink-700 ring-surface-border hover:bg-surface-sunken"
              }`}
            >
              {ACTION_TAKEN_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      {actionTaken === "yes" && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">How did you follow up?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {FOLLOWTHROUGH_ACTION_CHANNEL.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setActionChannel(c)}
                aria-pressed={actionChannel === c}
                className={`min-h-[36px] rounded-pill px-3 text-xs font-semibold ring-1 transition focus-ring ${
                  actionChannel === c ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-ink-700 ring-surface-border hover:bg-surface-sunken"
                }`}
              >
                {ACTION_CHANNEL_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Did the customer respond?</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FOLLOWTHROUGH_CUSTOMER_RESPONSE.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setCustomerResponse(r)}
              aria-pressed={customerResponse === r}
              className={`min-h-[36px] rounded-pill px-3 text-xs font-semibold ring-1 transition focus-ring ${
                customerResponse === r ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-ink-700 ring-surface-border hover:bg-surface-sunken"
              }`}
            >
              {CUSTOMER_RESPONSE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">What is the current business result?</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FOLLOWTHROUGH_BUSINESS_DISPOSITION.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setBusinessDisposition(d)}
              aria-pressed={businessDisposition === d}
              className={`min-h-[36px] rounded-pill px-3 text-xs font-semibold ring-1 transition focus-ring ${
                businessDisposition === d ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-ink-700 ring-surface-border hover:bg-surface-sunken"
              }`}
            >
              {BUSINESS_DISPOSITION_LABELS[d]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button type="button" size="sm" onClick={submit} disabled={submitting}>
          {submitting ? "Saving…" : existingFollowThrough ? "Update record" : "Save follow-through"}
        </Button>
        {error && (
          <p role="alert" className="text-xs font-medium text-danger-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
