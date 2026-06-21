import { PlumbingLead, LeadInsert, LeadUpdate, reviewVisibleStatuses } from "@/data/leadModel";
import { fetchGoogleSheetLeads } from "@/lib/leads/googleSheets";
import { fetchLeadsFromDb, fetchLeadByIdFromDb, insertLeadToDb, updateLeadInDb, deleteLeadFromDb } from "@/lib/leads/supabase";

export type LeadDataSource = "supabase" | "google-sheets" | "mock-fallback";

export async function getLeads(): Promise<{ leads: PlumbingLead[]; source: LeadDataSource; error?: boolean; message?: string }> {
  try {
    const dbLeads = await fetchLeadsFromDb();
    if (dbLeads.length > 0) {
      return { leads: dbLeads, source: "supabase" };
    }
  } catch (error) {
    console.error("[leads] Supabase fetch failed.", error);
  }

  try {
    const liveLeads = await fetchGoogleSheetLeads();
    return { leads: liveLeads, source: "google-sheets" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[leads] Google Sheets fetch failed.", error);
    return { leads: [], source: "mock-fallback", error: true, message };
  }
}

export async function getLeadById(id: string) {
  try {
    const dbLead = await fetchLeadByIdFromDb(id);
    if (dbLead) {
      return { lead: dbLead, source: "supabase" as const };
    }
  } catch (error) {
    console.error("[leads] Supabase fetch by id failed.", error);
  }

  const { leads, source } = await getLeads();
  return { lead: leads.find((item) => item.id === id), source };
}

export async function createLead(lead: LeadInsert) {
  return insertLeadToDb(lead);
}

export async function updateLead(id: string, update: LeadUpdate) {
  return updateLeadInDb(id, update);
}

export async function deleteLead(id: string) {
  return deleteLeadFromDb(id);
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
