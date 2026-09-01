"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  REVIEW_VERDICTS,
  REVIEW_WOULD_ACT,
  REVIEW_REASON_CODES,
  VERDICT_LABELS,
  WOULD_ACT_LABELS,
  REVIEW_REASON_CODE_LABELS,
  ReviewVerdict,
  ReviewWouldAct,
  ReviewReasonCode,
} from "@/lib/agents/estimateClosing/reviewTypes";

/**
 * P1 Sprint 3 — the owner's evaluation controls for a single shadow
 * recommendation (P1 Sprint 3 directive §9.D). Imports ONLY from
 * reviewTypes.ts (a dependency-free module), never from review.ts or
 * evaluationReadModel.ts directly — both transitively import next/headers
 * via SupabaseBusinessEventStore and would break the client bundle. This
 * component itself never touches business_events, an outcome, an
 * approval, or a tool — its only side effect is one POST to the owner-only
 * review API route.
 */
export function ReviewControls({ recommendationEventId }: { recommendationEventId: string }) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(null);
  const [wouldAct, setWouldAct] = useState<ReviewWouldAct | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReviewReasonCode[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ verdict: ReviewVerdict; wouldAct: ReviewWouldAct; reasonCodes: ReviewReasonCode[] } | null>(null);

  function toggleReasonCode(code: ReviewReasonCode) {
    setReasonCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  async function submit() {
    if (!verdict || !wouldAct) {
      setError("Choose a verdict and whether you'd act on it.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/estimate-closing/recommendations/${encodeURIComponent(recommendationEventId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, wouldAct, reasonCodes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to record your review.");
      setSubmitted({ verdict, wouldAct, reasonCodes });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record your review.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <p className="text-sm font-medium text-success-700">
        Recorded: {VERDICT_LABELS[submitted.verdict]} · {WOULD_ACT_LABELS[submitted.wouldAct]}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Was this recommendation right?</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {REVIEW_VERDICTS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVerdict(v)}
              aria-pressed={verdict === v}
              className={`min-h-[36px] rounded-pill px-3 text-xs font-semibold ring-1 transition focus-ring ${
                verdict === v ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-ink-700 ring-surface-border hover:bg-surface-sunken"
              }`}
            >
              {VERDICT_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Would you act on it?</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {REVIEW_WOULD_ACT.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWouldAct(w)}
              aria-pressed={wouldAct === w}
              className={`min-h-[36px] rounded-pill px-3 text-xs font-semibold ring-1 transition focus-ring ${
                wouldAct === w ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-ink-700 ring-surface-border hover:bg-surface-sunken"
              }`}
            >
              {WOULD_ACT_LABELS[w]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Why? (optional)</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {REVIEW_REASON_CODES.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => toggleReasonCode(code)}
              aria-pressed={reasonCodes.includes(code)}
              className={`min-h-[32px] rounded-pill px-2.5 text-xs font-medium ring-1 transition focus-ring ${
                reasonCodes.includes(code) ? "bg-ink-900 text-white ring-ink-900" : "bg-white text-ink-600 ring-surface-border hover:bg-surface-sunken"
              }`}
            >
              {REVIEW_REASON_CODE_LABELS[code]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button type="button" size="sm" onClick={submit} disabled={submitting}>
          {submitting ? "Saving…" : "Save review"}
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
