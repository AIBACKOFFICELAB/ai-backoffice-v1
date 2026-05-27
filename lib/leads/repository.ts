import { PlumbingLead, reviewVisibleStatuses } from "@/data/leadModel";
import { plumbingLeads } from "@/data/plumbingLeads";
import { fetchGoogleSheetLeads } from "@/lib/leads/googleSheets";

export type LeadDataSource = "google-sheets" | "mock-fallback";

export async function getLeads(): Promise<{ leads: PlumbingLead[]; source: LeadDataSource }> {
  try {
    const liveLeads = await fetchGoogleSheetLeads();
    return { leads: liveLeads, source: "google-sheets" };
  } catch (error) {
    console.error("[leads] Google Sheets fetch failed, falling back to mock data.", error);
  }

  return { leads: plumbingLeads, source: "mock-fallback" };
}

export async function getLeadById(id: string) {
  const { leads, source } = await getLeads();
  return { lead: leads.find((item) => item.id === id), source };
}

export function buildLeadMetrics(leads: PlumbingLead[]) {
  const today = new Date().toISOString().slice(0, 10);

  return {
    totalLeads: leads.length,
    newLeads: leads.filter((lead) => lead.status === "New").length,
    emergencyLeads: leads.filter((lead) => lead.emergency === "Yes").length,
    followUpsDue: leads.filter((lead) => lead.followUpDate && lead.followUpDate <= today).length,
    estimatesSent: leads.filter((lead) => lead.status === "Estimate Sent").length,
    jobsWon: leads.filter((lead) => lead.status === "Won").length,
    revenuePipeline: leads.filter((lead) => !["Lost", "Completed"].includes(lead.status)).reduce((sum, lead) => sum + lead.estimateAmount, 0),
    reviewPending: leads.filter((lead) => lead.reviewRequestStatus === "Ready to Send").length,
    reviewVisibleStatuses,
  };
}
