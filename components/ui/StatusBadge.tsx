import type { LeadStatus } from "@/data/leadModel";

export const LEAD_STATUSES: LeadStatus[] = [
  "New",
  "Contacted",
  "Scheduled",
  "Estimate Sent",
  "Won",
  "Lost",
  "Completed",
];

// Single source of truth for lead-status color coding. Previously this map
// was copy-pasted between LeadEditForm and LeadStatusSelect and could drift.
export const STATUS_STYLES: Record<LeadStatus, string> = {
  New: "bg-brand-100 text-brand-800",
  Contacted: "bg-amber-100 text-amber-800",
  Scheduled: "bg-cyan-100 text-cyan-800",
  "Estimate Sent": "bg-purple-100 text-purple-800",
  Won: "bg-emerald-100 text-emerald-800",
  Lost: "bg-red-100 text-red-800",
  Completed: "bg-slate-200 text-slate-700",
};

export function normalizeStatus(status: string): LeadStatus {
  return (LEAD_STATUSES as string[]).includes(status) ? (status as LeadStatus) : "New";
}

export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const normalized = normalizeStatus(status);
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[normalized]} ${className}`}
    >
      {normalized}
    </span>
  );
}
