"use client";

import { useId, useState } from "react";
import { LeadStatus } from "@/data/leadModel";
import { LEAD_STATUSES, STATUS_STYLES, normalizeStatus } from "@/components/ui/StatusBadge";

type Props = {
  leadId: string;
  initialStatus: string;
};

const DEFAULT_ERROR_MESSAGE = "Save failed — try again";

export default function LeadStatusSelect({ leadId, initialStatus }: Props) {
  const [status, setStatus] = useState<LeadStatus>(normalizeStatus(initialStatus));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    e.stopPropagation();
    const newStatus = e.target.value as LeadStatus;
    const prev = status;
    setStatus(newStatus);
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        setStatus(prev);
        // Surfaces the API's specific refusal reason when available (e.g.
        // "Enter a valid estimate amount..." — see
        // app/api/leads/[id]/route.ts's estimate-lifecycle validation) —
        // never a raw/unexpected response shape, always a safe fallback.
        const data = await res.json().catch(() => null);
        setError(typeof data?.error === "string" && data.error.length > 0 ? data.error : DEFAULT_ERROR_MESSAGE);
      }
    } catch {
      setStatus(prev);
      setError(DEFAULT_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <select
        value={status}
        onChange={handleChange}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        aria-describedby={error ? errorId : undefined}
        className={`rounded-pill border px-2.5 py-1 text-xs font-semibold cursor-pointer focus-ring disabled:opacity-50 ${
          error ? "border-red-400 bg-red-50 text-red-700" : `border-transparent ${STATUS_STYLES[status]}`
        }`}
      >
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <span id={errorId} role="alert" className={`mt-1 max-w-[14rem] text-right text-[11px] font-medium text-red-600 ${error ? "" : "sr-only"}`}>
        {error ?? ""}
      </span>
    </span>
  );
}
