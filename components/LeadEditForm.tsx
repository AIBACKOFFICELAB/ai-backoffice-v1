"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlumbingLead, LeadStatus } from "@/data/leadModel";

const STATUSES: LeadStatus[] = ["New", "Contacted", "Scheduled", "Estimate Sent", "Won", "Lost", "Completed"];

const STATUS_STYLES: Record<string, string> = {
  New: "bg-blue-100 text-blue-800",
  Contacted: "bg-amber-100 text-amber-800",
  Scheduled: "bg-cyan-100 text-cyan-800",
  "Estimate Sent": "bg-purple-100 text-purple-800",
  Won: "bg-green-100 text-green-800",
  Lost: "bg-red-100 text-red-800",
  Completed: "bg-slate-100 text-slate-800",
};

export default function LeadEditForm({ lead }: { lead: PlumbingLead }) {
  const router = useRouter();

  const [status, setStatus] = useState<LeadStatus>(
    (STATUSES.includes(lead.status as LeadStatus) ? lead.status : "New") as LeadStatus
  );
  const [estimateAmount, setEstimateAmount] = useState(lead.estimateAmount.toString());
  const [followUpDate, setFollowUpDate] = useState(lead.followUpDate || "");
  const [internalNotes, setInternalNotes] = useState(lead.internalNotes || "");

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const amount = parseFloat(estimateAmount);
    if (isNaN(amount) || amount < 0) {
      setError("Estimate amount must be 0 or greater.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          estimateAmount: amount,
          followUpDate: followUpDate || undefined,
          internalNotes,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save changes.");
      }

      setSavedAt(Date.now());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  }

  const justSaved = savedAt !== null && Date.now() - savedAt < 3000;

  return (
    <form onSubmit={handleSubmit} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 space-y-4">
      <h2 className="font-semibold text-slate-900">Update Lead</h2>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as LeadStatus)}
            className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 ${STATUS_STYLES[status] ?? ""}`}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Estimate Amount ($)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={estimateAmount}
            onChange={(e) => setEstimateAmount(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Follow-Up Date</label>
          <input
            type="date"
            value={followUpDate}
            onChange={(e) => setFollowUpDate(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Internal Notes</label>
        <textarea
          value={internalNotes}
          onChange={(e) => setInternalNotes(e.target.value)}
          rows={4}
          placeholder="Add internal notes..."
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving..." : justSaved ? "Saved!" : "Save Changes"}
      </button>
    </form>
  );
}
