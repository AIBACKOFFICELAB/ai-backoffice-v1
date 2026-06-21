"use client";

import { useState } from "react";
import { LeadStatus } from "@/data/leadModel";

const STATUSES: LeadStatus[] = ["New", "Contacted", "Estimate Sent", "Won", "Lost"];

const STATUS_STYLES: Record<string, string> = {
  New: "bg-blue-100 text-blue-700",
  Contacted: "bg-amber-100 text-amber-700",
  "Estimate Sent": "bg-purple-100 text-purple-700",
  Won: "bg-green-100 text-green-700",
  Lost: "bg-red-100 text-red-700",
};

type Props = {
  leadId: string;
  initialStatus: string;
};

export default function LeadStatusSelect({ leadId, initialStatus }: Props) {
  const normalizedInitial = STATUSES.includes(initialStatus as LeadStatus)
    ? (initialStatus as LeadStatus)
    : "New";

  const [status, setStatus] = useState<LeadStatus>(normalizedInitial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

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
    <select
      value={status}
      onChange={handleChange}
      onClick={(e) => e.stopPropagation()}
      disabled={saving}
      title={error ? "Save failed — try again" : undefined}
      className={`rounded-full px-2 py-1 text-xs font-semibold border cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${
        error ? "border-red-400 bg-red-50 text-red-700" : `border-transparent ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`
      }`}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
