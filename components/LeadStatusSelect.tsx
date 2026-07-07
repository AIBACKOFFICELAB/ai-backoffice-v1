"use client";

import { useId, useState } from "react";
import { LeadStatus } from "@/data/leadModel";
import { LEAD_STATUSES, STATUS_STYLES, normalizeStatus } from "@/components/ui/StatusBadge";

type Props = {
  leadId: string;
  initialStatus: string;
};

export default function LeadStatusSelect({ leadId, initialStatus }: Props) {
  const [status, setStatus] = useState<LeadStatus>(normalizeStatus(initialStatus));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const errorId = useId();

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    e.stopPropagation();
    const newStatus = e.target.value as LeadStatus;
    const prev = status;
    setStatus(newStatus);
    setError(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        setStatus(prev);
        setError(true);
      }
    } catch {
      setStatus(prev);
      setError(true);
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
      <span id={errorId} role="alert" className={`mt-1 text-[11px] font-medium text-red-600 ${error ? "" : "sr-only"}`}>
        {error ? "Save failed — try again" : ""}
      </span>
    </span>
  );
}
