"use client";

import { useMemo, useState } from "react";

type LeadStatus = "New" | "Contacted" | "Scheduled" | "Estimate Sent" | "Won" | "Lost" | "Completed";
type Urgency = "Emergency" | "Same Day" | "This Week" | "Flexible";
type LeadSource = "Google" | "Website" | "Facebook" | "Instagram" | "Referral" | "Repeat Customer" | "Yelp" | "Other";
type ReviewRequestStatus = "Not Ready" | "Ready to Send" | "Sent" | "Review Received";

type LeadRecord = {
  id: string;
  date: string;
  customerName: string;
  phone: string;
  email: string;
  serviceType: string;
  leadSource: LeadSource;
  urgency: Urgency;
  jobDescription: string;
  status: LeadStatus;
  estimateAmount: number | null;
  followUpDate: string | null;
  reviewRequestStatus: ReviewRequestStatus;
  notes: string;
};

const STATUS_OPTIONS: LeadStatus[] = ["New", "Contacted", "Scheduled", "Estimate Sent", "Won", "Lost", "Completed"];
const URGENCY_OPTIONS: Urgency[] = ["Emergency", "Same Day", "This Week", "Flexible"];
const SOURCE_OPTIONS: LeadSource[] = ["Google", "Website", "Facebook", "Instagram", "Referral", "Repeat Customer", "Yelp", "Other"];
const REVIEW_OPTIONS: ReviewRequestStatus[] = ["Not Ready", "Ready to Send", "Sent", "Review Received"];

const INITIAL_LEADS: LeadRecord[] = [
  { id: "LD-1001", date: "May 18, 2026, 10:40 AM", customerName: "Maria Rodriguez", phone: "(512) 555-0189", email: "maria.r@example.com", serviceType: "Plumbing", leadSource: "Google", urgency: "Emergency", jobDescription: "Main line sewer backup flooding downstairs bathroom.", status: "New", estimateAmount: null, followUpDate: "2026-05-18", reviewRequestStatus: "Not Ready", notes: "Customer requested immediate callback. Water shutoff location unknown." },
  { id: "LD-1002", date: "May 18, 2026, 9:05 AM", customerName: "James Whitaker", phone: "(214) 555-0123", email: "jwhitaker@example.com", serviceType: "HVAC", leadSource: "Website", urgency: "Same Day", jobDescription: "AC unit blowing warm air, compressor humming loudly.", status: "Contacted", estimateAmount: 275, followUpDate: "2026-05-19", reviewRequestStatus: "Not Ready", notes: "Tech availability after 2:00 PM only." },
  { id: "LD-1003", date: "May 17, 2026, 3:22 PM", customerName: "Tonya Green", phone: "(602) 555-0178", email: "tonya.green@example.com", serviceType: "Electrical", leadSource: "Referral", urgency: "This Week", jobDescription: "Breaker panel sparking when dryer runs.", status: "Scheduled", estimateAmount: 650, followUpDate: "2026-05-20", reviewRequestStatus: "Not Ready", notes: "Inspection scheduled Wednesday morning." },
  { id: "LD-1004", date: "May 16, 2026, 1:10 PM", customerName: "Elliot Barnes", phone: "(303) 555-0144", email: "elliot.b@example.com", serviceType: "Remodeling", leadSource: "Instagram", urgency: "Flexible", jobDescription: "Kitchen backsplash installation tile work.", status: "Estimate Sent", estimateAmount: 4500, followUpDate: "2026-05-22", reviewRequestStatus: "Not Ready", notes: "Quote sent with material options and timeline." },
  { id: "LD-1005", date: "May 15, 2026, 11:50 AM", customerName: "Ashley Kim", phone: "(919) 555-0109", email: "ashley.kim@example.com", serviceType: "Cleaning Services", leadSource: "Repeat Customer", urgency: "This Week", jobDescription: "Full move-out deep clean.", status: "Completed", estimateAmount: 380, followUpDate: null, reviewRequestStatus: "Sent", notes: "Service completed; waiting on posted review." },
];

const parseLeadDate = (value: string) => new Date(value).getTime();
const formatEstimate = (amount: number | null) => (amount === null ? "No estimate" : `$${amount.toLocaleString()}`);

function toggleValue<T extends string>(current: T[], value: T) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export default function LeadInboxPage() {
  const [leads, setLeads] = useState<LeadRecord[]>(INITIAL_LEADS);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus[]>([]);
  const [urgencyFilter, setUrgencyFilter] = useState<Urgency[]>([]);
  const [sourceFilter, setSourceFilter] = useState<LeadSource[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewRequestStatus[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  const selectedLead = leads.find((lead) => lead.id === selectedLeadId) ?? null;

  const metrics = useMemo(() => ({
    totalLeads: leads.length,
    newLeads: leads.filter((lead) => lead.status === "New").length,
    emergencyLeads: leads.filter((lead) => lead.urgency === "Emergency").length,
    followUpsDue: leads.filter((lead) => lead.followUpDate !== null && lead.status !== "Completed").length,
    estimatesSent: leads.filter((lead) => lead.status === "Estimate Sent").length,
    jobsWon: leads.filter((lead) => lead.status === "Won").length,
    reviewPending: leads.filter((lead) => lead.reviewRequestStatus === "Ready to Send").length,
  }), [leads]);

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return leads
      .filter((lead) => {
        const matchesQuery =
          query.length === 0 ||
          [lead.customerName, lead.phone, lead.email, lead.serviceType, lead.leadSource, lead.jobDescription]
            .join(" ")
            .toLowerCase()
            .includes(query);

        return (
          matchesQuery &&
          (statusFilter.length === 0 || statusFilter.includes(lead.status)) &&
          (urgencyFilter.length === 0 || urgencyFilter.includes(lead.urgency)) &&
          (sourceFilter.length === 0 || sourceFilter.includes(lead.leadSource)) &&
          (reviewFilter.length === 0 || reviewFilter.includes(lead.reviewRequestStatus))
        );
      })
      .sort((a, b) => {
        const aEmergency = a.urgency === "Emergency" && a.status !== "Completed";
        const bEmergency = b.urgency === "Emergency" && b.status !== "Completed";
        if (aEmergency !== bEmergency) return aEmergency ? -1 : 1;
        return parseLeadDate(b.date) - parseLeadDate(a.date);
      });
  }, [leads, search, sourceFilter, statusFilter, urgencyFilter, reviewFilter]);

  const updateLead = (id: string, updates: Partial<LeadRecord>) => {
    setLeads((current) => current.map((lead) => (lead.id === id ? { ...lead, ...updates } : lead)));
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Lead Inbox</h1>
        <p className="text-slate-600">Track every inbound lead, prioritize urgent jobs, and move work from inquiry to booked revenue.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {[
          ["Total Leads", metrics.totalLeads],
          ["New Leads", metrics.newLeads],
          ["Emergency Leads", metrics.emergencyLeads],
          ["Follow-Ups Due", metrics.followUpsDue],
          ["Estimates Sent", metrics.estimatesSent],
          ["Jobs Won", metrics.jobsWon],
          ["Review Requests Pending", metrics.reviewPending],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email, service, source, job..." className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 xl:col-span-2" />
          <details className="rounded-lg border border-slate-300 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Status ({statusFilter.length || "All"})</summary>
            <div className="mt-2 space-y-1 text-sm">{STATUS_OPTIONS.map((option) => <label key={option} className="flex items-center gap-2"><input type="checkbox" checked={statusFilter.includes(option)} onChange={() => setStatusFilter((curr) => toggleValue(curr, option))} /><span>{option}</span></label>)}</div>
          </details>
          <details className="rounded-lg border border-slate-300 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Urgency ({urgencyFilter.length || "All"})</summary>
            <div className="mt-2 space-y-1 text-sm">{URGENCY_OPTIONS.map((option) => <label key={option} className="flex items-center gap-2"><input type="checkbox" checked={urgencyFilter.includes(option)} onChange={() => setUrgencyFilter((curr) => toggleValue(curr, option))} /><span>{option}</span></label>)}</div>
          </details>
          <details className="rounded-lg border border-slate-300 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Lead Source ({sourceFilter.length || "All"})</summary>
            <div className="mt-2 space-y-1 text-sm">{SOURCE_OPTIONS.map((option) => <label key={option} className="flex items-center gap-2"><input type="checkbox" checked={sourceFilter.includes(option)} onChange={() => setSourceFilter((curr) => toggleValue(curr, option))} /><span>{option}</span></label>)}</div>
          </details>
          <details className="rounded-lg border border-slate-300 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Review ({reviewFilter.length || "All"})</summary>
            <div className="mt-2 space-y-1 text-sm">{REVIEW_OPTIONS.map((option) => <label key={option} className="flex items-center gap-2"><input type="checkbox" checked={reviewFilter.includes(option)} onChange={() => setReviewFilter((curr) => toggleValue(curr, option))} /><span>{option}</span></label>)}</div>
          </details>
        </div>
      </div>

      <div className="space-y-3">
        {filteredLeads.map((lead) => {
          const isEmergency = lead.urgency === "Emergency" && lead.status !== "Completed";
          const isLowPriority = lead.status === "Completed" || lead.status === "Lost";
          return (
            <button key={lead.id} onClick={() => setSelectedLeadId(lead.id)} className={`w-full rounded-xl border p-4 text-left transition hover:shadow-md ${isEmergency ? "border-red-600 bg-red-50" : "border-slate-200 bg-white"} ${isLowPriority ? "opacity-60 saturate-50" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-slate-900">
                    {lead.customerName} {lead.status === "New" && <span className="ml-2 inline-block h-2.5 w-2.5 rounded-full bg-blue-500 align-middle" />}
                    {isEmergency && <span className="ml-2 inline-block animate-pulse text-red-600">●</span>}
                  </p>
                  <p className="text-xs text-slate-500">{lead.date}</p>
                  <p className="mt-1 text-sm text-slate-700">{lead.phone} • {lead.email}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{lead.serviceType}</span>
                  <span className={`rounded-full px-2 py-1 ${lead.urgency === "Emergency" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{lead.urgency}</span>
                  <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700">{lead.status}</span>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-700">{lead.jobDescription}</p>
              <p className={`mt-2 text-sm font-medium text-slate-700 ${isLowPriority ? "line-through" : ""}`}>{formatEstimate(lead.estimateAmount)}</p>
            </button>
          );
        })}
      </div>

      {selectedLead && (
        <div className="fixed inset-0 z-30 bg-slate-950/30" onClick={() => setSelectedLeadId(null)}>
          <div className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">{selectedLead.customerName}</h2>
                <p className="text-sm text-slate-600">{selectedLead.jobDescription}</p>
              </div>
              <button onClick={() => setSelectedLeadId(null)} className="text-slate-500 hover:text-slate-800">✕</button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={`tel:${selectedLead.phone}`} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">📞 Call</a>
              <a href={`sms:${selectedLead.phone}`} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">💬 Text</a>
              <a href={`mailto:${selectedLead.email}`} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">✉️ Email</a>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Status<select className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedLead.status} onChange={(e) => updateLead(selectedLead.id, { status: e.target.value as LeadStatus })}>{STATUS_OPTIONS.map((opt) => <option key={opt}>{opt}</option>)}</select></label>
              <label className="text-sm">Urgency<select className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedLead.urgency} onChange={(e) => updateLead(selectedLead.id, { urgency: e.target.value as Urgency })}>{URGENCY_OPTIONS.map((opt) => <option key={opt}>{opt}</option>)}</select></label>
              <label className="text-sm">Review Request<select className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedLead.reviewRequestStatus} onChange={(e) => updateLead(selectedLead.id, { reviewRequestStatus: e.target.value as ReviewRequestStatus })}>{REVIEW_OPTIONS.map((opt) => <option key={opt}>{opt}</option>)}</select></label>
              <label className="text-sm">Estimate Amount<input type="number" placeholder="0" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedLead.estimateAmount ?? ""} onChange={(e) => updateLead(selectedLead.id, { estimateAmount: e.target.value === "" ? null : Number(e.target.value) })} /></label>
              <label className="text-sm sm:col-span-2">Follow-Up Date<input type="date" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedLead.followUpDate ?? ""} onChange={(e) => updateLead(selectedLead.id, { followUpDate: e.target.value || null })} /></label>
              <label className="text-sm sm:col-span-2">Notes<textarea rows={4} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedLead.notes} onChange={(e) => updateLead(selectedLead.id, { notes: e.target.value })} /></label>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => updateLead(selectedLead.id, { status: "Contacted" })} className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Mark Contacted</button>
              <button onClick={() => updateLead(selectedLead.id, { status: "Scheduled", followUpDate: selectedLead.followUpDate ?? "2026-05-20" })} className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Schedule Follow-Up</button>
              <button onClick={() => updateLead(selectedLead.id, { status: "Estimate Sent" })} className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Mark Estimate Sent</button>
              <button onClick={() => updateLead(selectedLead.id, { status: "Won" })} className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Mark Won</button>
              <button onClick={() => updateLead(selectedLead.id, { status: "Completed" })} className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Mark Completed</button>
              <button onClick={() => updateLead(selectedLead.id, { reviewRequestStatus: "Sent" })} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">Send Review Request</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
