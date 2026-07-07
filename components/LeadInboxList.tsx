"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PlumbingLead, LeadStatus } from "@/data/leadModel";
import { LEAD_STATUSES } from "@/components/ui/StatusBadge";
import LeadStatusSelect from "@/components/LeadStatusSelect";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Field";

function sortLeads(leads: PlumbingLead[]) {
  return [...leads].sort((a, b) => {
    if (a.emergency === "Yes" && b.emergency !== "Yes") return -1;
    if (a.emergency !== "Yes" && b.emergency === "Yes") return 1;
    if (["Completed", "Lost"].includes(a.status) && !["Completed", "Lost"].includes(b.status)) return 1;
    if (!["Completed", "Lost"].includes(a.status) && ["Completed", "Lost"].includes(b.status)) return -1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

export function LeadInboxList({ leads }: { leads: PlumbingLead[] }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "All">("All");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byQuery = q
      ? leads.filter((lead) =>
          [lead.customerName, lead.phone, lead.email, lead.serviceAddress]
            .filter(Boolean)
            .some((field) => field.toLowerCase().includes(q))
        )
      : leads;
    const byStatus = statusFilter === "All" ? byQuery : byQuery.filter((lead) => lead.status === statusFilter);
    return sortLeads(byStatus);
  }, [leads, query, statusFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M18 18l-3.8-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <Input
            aria-label="Search leads by name, phone, email, or address"
            placeholder="Search by name, phone, email, or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "All")}
          className="rounded-control border border-surface-border bg-white px-3.5 py-2.5 text-sm font-medium text-ink-700 focus-ring sm:w-52"
        >
          <option value="All">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={leads.length === 0 ? "No leads yet" : "No leads match your search"}
          description={
            leads.length === 0
              ? "New inquiries from calls, forms, and messages will show up here automatically."
              : "Try a different name, phone number, or status filter."
          }
        />
      ) : (
        <div className="grid gap-4">
          {filtered.map((lead) => {
            const isEmergency = lead.emergency === "Yes";
            const isLowPriority = ["Completed", "Lost"].includes(lead.status);
            return (
              <div
                key={lead.id}
                className={`rounded-card bg-white shadow-card ring-1 transition hover:shadow-raised ${
                  isEmergency ? "border-2 border-red-500 ring-red-200" : "ring-surface-border"
                } ${isLowPriority ? "opacity-60" : "opacity-100"}`}
              >
                <Link href={`/leads/${lead.id}`} className="block p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold text-ink-900">
                        {isEmergency ? "🚨 " : ""}
                        {lead.customerName}
                      </p>
                      <p className="text-sm text-ink-500">
                        {new Date(lead.date).toLocaleString()} &bull; {lead.phone} &bull;{" "}
                        {lead.email || "No email provided"}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {lead.status === "New" && (
                        <span className="rounded-pill bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-800">
                          New lead
                        </span>
                      )}
                      <LeadStatusSelect leadId={lead.id} initialStatus={lead.status} />
                      <span
                        className={`rounded-pill px-2.5 py-1 text-xs font-semibold ${
                          isEmergency ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {lead.urgency}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 text-sm text-ink-700 md:grid-cols-2 xl:grid-cols-4">
                    <p><span className="font-semibold">Address:</span> {lead.serviceAddress}</p>
                    <p><span className="font-semibold">Property:</span> {lead.propertyType}</p>
                    <p><span className="font-semibold">Service:</span> {lead.serviceType}</p>
                    <p><span className="font-semibold">Emergency:</span> {lead.emergency}</p>
                    <p><span className="font-semibold">Lead source:</span> {lead.leadSource}</p>
                    <p><span className="font-semibold">Customer role:</span> {lead.customerRole}</p>
                    <p><span className="font-semibold">Estimate:</span> ${lead.estimateAmount.toLocaleString()}</p>
                    <p><span className="font-semibold">Follow-up:</span> {lead.followUpDate || "Not set"}</p>
                  </div>

                  <p className="mt-2 text-sm text-ink-700">
                    <span className="font-semibold text-ink-900">Job:</span> {lead.jobDescription}
                  </p>
                  {lead.internalNotes && (
                    <p className="mt-1 text-sm text-ink-500">
                      <span className="font-semibold text-ink-700">Internal:</span> {lead.internalNotes}
                    </p>
                  )}
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
