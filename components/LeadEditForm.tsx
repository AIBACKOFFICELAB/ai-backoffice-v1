"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { PlumbingLead, LeadStatus } from "@/data/leadModel";
import { LEAD_STATUSES, STATUS_STYLES, normalizeStatus } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea, FieldError } from "@/components/ui/Field";

/**
 * "unknown" is deliberately distinct from "disabled": it means the tenant's
 * automation setting could not be confirmed right now (a genuine query/RLS
 * error), NOT that it's confirmed off — never collapsed together, since a
 * later cron run reads the real setting regardless of what this page could
 * show (Codex review finding on PR #23). Inlined here (not imported from
 * lib/modules/estimateFollowup/service.ts) to keep this "use client"
 * component's props boundary free of any transitive next/headers import,
 * matching this repo's established reviewTypes.ts-style precedent.
 */
type FollowupAutomationStatus = "enabled" | "disabled" | "unknown";

export default function LeadEditForm({ lead, followupStatus }: { lead: PlumbingLead; followupStatus: FollowupAutomationStatus }) {
  const router = useRouter();

  const [status, setStatus] = useState<LeadStatus>(normalizeStatus(lead.status));
  const [estimateAmount, setEstimateAmount] = useState(lead.estimateAmount.toString());
  const [followUpDate, setFollowUpDate] = useState(lead.followUpDate || "");
  const [internalNotes, setInternalNotes] = useState(lead.internalNotes || "");

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();

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
    <form onSubmit={handleSubmit} className="rounded-card bg-white p-5 shadow-card ring-1 ring-surface-border space-y-4">
      <h2 className="font-semibold text-ink-900">Update lead</h2>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="lead-status">Status</Label>
          <select
            id="lead-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as LeadStatus)}
            className={`w-full rounded-control border border-surface-border px-3 py-2.5 text-sm font-semibold focus-ring ${STATUS_STYLES[status]}`}
          >
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {status === "Estimate Sent" && (
            <p className="mt-1.5 text-xs text-ink-500">
              {followupStatus === "enabled"
                ? "This enrolls the customer in your Day 1/3/7 follow-up — automated SMS may be sent unless they reply or the status changes."
                : followupStatus === "disabled"
                  ? "Your Estimate Follow-up automation is currently OFF for this account — no automated messages will be sent."
                  : "We couldn't confirm your Follow-up automation status right now — check Settings before assuming messages will or won't send."}
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="lead-estimate">Estimate amount ($)</Label>
          <Input
            id="lead-estimate"
            type="number"
            min="0"
            step="0.01"
            value={estimateAmount}
            onChange={(e) => setEstimateAmount(e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="lead-followup">Follow-up date</Label>
          <Input
            id="lead-followup"
            type="date"
            value={followUpDate}
            onChange={(e) => setFollowUpDate(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="lead-notes">Internal notes</Label>
        <Textarea
          id="lead-notes"
          value={internalNotes}
          onChange={(e) => setInternalNotes(e.target.value)}
          rows={4}
          placeholder="Add internal notes..."
        />
      </div>

      {error && <FieldError>{error}</FieldError>}
      <div aria-live="polite" id={statusId} className="sr-only">
        {saving ? "Saving changes" : justSaved ? "Changes saved" : ""}
      </div>

      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : justSaved ? "Saved!" : "Save changes"}
      </Button>
    </form>
  );
}
