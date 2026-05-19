"use client";

import { useMemo, useState } from "react";

type LeadStatus = "New" | "Contacted" | "Follow-Up Scheduled" | "Estimate Sent" | "Won" | "Completed" | "Lost";
type Urgency = "Emergency" | "High" | "Medium" | "Low";
type ReviewRequestStatus = "Not Sent" | "Pending" | "Sent" | "Completed";
type LeadSource = "Missed Call" | "Website Form" | "Facebook" | "Google Business Profile";

type Lead = {
  id: string;
  date: string;
  customerName: string;
  phone: string;
  email: string;
  serviceType: "Plumbing" | "HVAC" | "Electrical" | "Roofing" | "Cleaning";
  leadSource: LeadSource;
  urgency: Urgency;
  jobDescription: string;
  status: LeadStatus;
  estimateAmount: number;
  followUpDate: string;
  reviewRequestStatus: ReviewRequestStatus;
  notes: string;
};

const initialLeads: Lead[] = [
  {
    id: "L-1001",
    date: "2026-05-19T08:31:00Z",
    customerName: "Jason Miller",
    phone: "+15551039921",
    email: "jason.miller@email.com",
    serviceType: "Plumbing",
    leadSource: "Missed Call",
    urgency: "Emergency",
    jobDescription: "Water heater burst in basement. Needs same-day replacement.",
    status: "New",
    estimateAmount: 0,
    followUpDate: "2026-05-19",
    reviewRequestStatus: "Not Sent",
    notes: "Left voicemail at 8:35 AM.",
  },
  {
    id: "L-1002",
    date: "2026-05-19T10:05:00Z",
    customerName: "Angela Ruiz",
    phone: "+15558421019",
    email: "angela.ruiz@email.com",
    serviceType: "HVAC",
    leadSource: "Website Form",
    urgency: "High",
    jobDescription: "AC blowing warm air. Wants diagnostic this afternoon.",
    status: "Estimate Sent",
    estimateAmount: 780,
    followUpDate: "2026-05-20",
    reviewRequestStatus: "Not Sent",
    notes: "Estimate emailed, asked for financing options.",
  },
  {
    id: "L-1003",
    date: "2026-05-18T14:42:00Z",
    customerName: "Marcus Lee",
    phone: "+15557106540",
    email: "marcus.lee@email.com",
    serviceType: "Electrical",
    leadSource: "Facebook",
    urgency: "Medium",
    jobDescription: "Needs quote for panel upgrade to 200A.",
    status: "Won",
    estimateAmount: 3900,
    followUpDate: "2026-05-21",
    reviewRequestStatus: "Pending",
    notes: "Booked for Thursday morning.",
  },
  {
    id: "L-1004",
    date: "2026-05-17T09:15:00Z",
    customerName: "Sharon Patel",
    phone: "+15552843005",
    email: "sharon.patel@email.com",
    serviceType: "Roofing",
    leadSource: "Google Business Profile",
    urgency: "Low",
    jobDescription: "Leak inspection completed, waiting for closeout notes.",
    status: "Completed",
    estimateAmount: 1150,
    followUpDate: "2026-05-17",
    reviewRequestStatus: "Pending",
    notes: "Need to send review request today.",
  },
];

const statusOptions: LeadStatus[] = ["New", "Contacted", "Follow-Up Scheduled", "Estimate Sent", "Won", "Completed", "Lost"];
const urgencyOptions: Urgency[] = ["Emergency", "High", "Medium", "Low"];
const reviewOptions: ReviewRequestStatus[] = ["Not Sent", "Pending", "Sent", "Completed"];

export default function LeadInboxPage() {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [urgencyFilter, setUrgencyFilter] = useState<string>("All");
  const [serviceFilter, setServiceFilter] = useState<string>("All");
  const [sourceFilter, setSourceFilter] = useState<string>("All");
  const [reviewFilter, setReviewFilter] = useState<string>("All");
  const [search, setSearch] = useState("");

  const selectedLead = leads.find((lead) => lead.id === selectedLeadId) ?? null;

  const updateLead = (id: string, patch: Partial<Lead>) => {
    setLeads((prev) => prev.map((lead) => (lead.id === id ? { ...lead, ...patch } : lead)));
  };

  const todayIso = new Date().toISOString().slice(0, 10);

  const filteredAndSortedLeads = useMemo(() => {
    const filtered = leads.filter((lead) => {
      const matchesStatus = statusFilter === "All" || lead.status === statusFilter;
      const matchesUrgency = urgencyFilter === "All" || lead.urgency === urgencyFilter;
      const matchesService = serviceFilter === "All" || lead.serviceType === serviceFilter;
      const matchesSource = sourceFilter === "All" || lead.leadSource === sourceFilter;
      const matchesReview = reviewFilter === "All" || lead.reviewRequestStatus === reviewFilter;
      const query = search.trim().toLowerCase();
      const matchesSearch =
        query.length === 0 ||
        [lead.customerName, lead.email, lead.phone, lead.jobDescription, lead.serviceType, lead.notes]
          .join(" ")
          .toLowerCase()
          .includes(query);

      return matchesStatus && matchesUrgency && matchesService && matchesSource && matchesReview && matchesSearch;
    });

    return filtered.sort((a, b) => {
      if (a.urgency === "Emergency" && b.urgency !== "Emergency") return -1;
      if (a.urgency !== "Emergency" && b.urgency === "Emergency") return 1;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }, [leads, reviewFilter, search, serviceFilter, sourceFilter, statusFilter, urgencyFilter]);

  const kpis = useMemo(() => {
    const followUpsDue = leads.filter((lead) => lead.followUpDate && lead.followUpDate <= todayIso).length;
    return [
      { label: "Total", value: leads.length },
      { label: "New", value: leads.filter((lead) => lead.status === "New").length },
      { label: "Emergency", value: leads.filter((lead) => lead.urgency === "Emergency").length },
      { label: "Follow-Ups Due", value: followUpsDue },
      { label: "Estimates Sent", value: leads.filter((lead) => lead.status === "Estimate Sent").length },
      { label: "Jobs Won", value: leads.filter((lead) => lead.status === "Won").length },
      { label: "Review Requests Pending", value: leads.filter((lead) => lead.reviewRequestStatus === "Pending").length },
    ];
  }, [leads, todayIso]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Lead Inbox</h1>
        <p className="text-slate-600">Capture missed opportunities, follow up faster, and close more jobs.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{kpi.label}</p>
            <p className="mt-2 text-2xl font-bold text-slate-900">{kpi.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} />
          {[ ["Status", statusFilter, setStatusFilter, statusOptions], ["Urgency", urgencyFilter, setUrgencyFilter, urgencyOptions], ["Service", serviceFilter, setServiceFilter, ["Plumbing", "HVAC", "Electrical", "Roofing", "Cleaning"]], ["Lead Source", sourceFilter, setSourceFilter, ["Missed Call", "Website Form", "Facebook", "Google Business Profile"]], ["Review", reviewFilter, setReviewFilter, reviewOptions] ].map(([label, value, onChange, options]) => (
            <label key={String(label)} className="text-xs font-semibold text-slate-600">
              {String(label)}
              <select className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal" value={String(value)} onChange={(e) => (onChange as (value: string) => void)(e.target.value)}>
                <option>All</option>
                {(options as string[]).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-4">
        {filteredAndSortedLeads.map((lead) => {
          const isEmergency = lead.urgency === "Emergency";
          const isInactive = lead.status === "Completed" || lead.status === "Lost";
          return (
            <button
              key={lead.id}
              onClick={() => setSelectedLeadId(lead.id)}
              className={`w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition hover:shadow-md ${isEmergency ? "border-2 border-red-500 ring-red-200" : "ring-slate-200"} ${isInactive ? "opacity-60" : "opacity-100"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold text-slate-900">{isEmergency ? "🚨 " : ""}{lead.customerName}</p>
                  <p className="text-sm text-slate-600">{lead.serviceType} • {lead.jobDescription}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {lead.status === "New" && <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">New</span>}
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{lead.status}</span>
                  <span className={`rounded-full px-2 py-1 text-xs font-semibold ${isEmergency ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{lead.urgency}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {selectedLead && (
        <div className="fixed inset-0 z-40 bg-slate-900/40" onClick={() => setSelectedLeadId(null)}>
          <aside className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-900">{selectedLead.customerName}</h2>
              <button className="text-slate-500" onClick={() => setSelectedLeadId(null)}>Close</button>
            </div>
            <div className="space-y-3">
              <p className="text-sm text-slate-600">{selectedLead.jobDescription}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm font-medium">Status<select className="mt-1 w-full rounded border px-2 py-2" value={selectedLead.status} onChange={(e) => updateLead(selectedLead.id, { status: e.target.value as LeadStatus })}>{statusOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
                <label className="text-sm font-medium">Urgency<select className="mt-1 w-full rounded border px-2 py-2" value={selectedLead.urgency} onChange={(e) => updateLead(selectedLead.id, { urgency: e.target.value as Urgency })}>{urgencyOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
              </div>
              <label className="text-sm font-medium">Review Request Status<select className="mt-1 w-full rounded border px-2 py-2" value={selectedLead.reviewRequestStatus} onChange={(e) => updateLead(selectedLead.id, { reviewRequestStatus: e.target.value as ReviewRequestStatus })}>{reviewOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
              <label className="text-sm font-medium">Estimate Amount<input type="number" className="mt-1 w-full rounded border px-2 py-2" value={selectedLead.estimateAmount} onChange={(e) => updateLead(selectedLead.id, { estimateAmount: Number(e.target.value) || 0 })} /></label>
              <label className="text-sm font-medium">Follow-Up Date<input type="date" className="mt-1 w-full rounded border px-2 py-2" value={selectedLead.followUpDate} onChange={(e) => updateLead(selectedLead.id, { followUpDate: e.target.value })} /></label>
              <label className="text-sm font-medium">Notes<textarea className="mt-1 w-full rounded border px-2 py-2" rows={4} value={selectedLead.notes} onChange={(e) => updateLead(selectedLead.id, { notes: e.target.value })} /></label>

              <div className="grid grid-cols-3 gap-2">
                <a className="rounded bg-slate-100 px-3 py-2 text-center text-sm font-semibold" href={`tel:${selectedLead.phone}`}>Call</a>
                <a className="rounded bg-slate-100 px-3 py-2 text-center text-sm font-semibold" href={`sms:${selectedLead.phone}`}>Text</a>
                <a className="rounded bg-slate-100 px-3 py-2 text-center text-sm font-semibold" href={`mailto:${selectedLead.email}`}>Email</a>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => updateLead(selectedLead.id, { status: "Contacted" })}>Mark Contacted</button>
                <button className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => updateLead(selectedLead.id, { status: "Follow-Up Scheduled" })}>Schedule Follow-Up</button>
                <button className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => updateLead(selectedLead.id, { status: "Estimate Sent" })}>Mark Estimate Sent</button>
                <button className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => updateLead(selectedLead.id, { status: "Won" })}>Mark Won</button>
                <button className="rounded bg-slate-700 px-3 py-2 text-sm font-semibold text-white" onClick={() => updateLead(selectedLead.id, { status: "Completed" })}>Mark Completed</button>
                <button className="rounded bg-violet-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => updateLead(selectedLead.id, { reviewRequestStatus: "Sent" })}>Send Review Request</button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
