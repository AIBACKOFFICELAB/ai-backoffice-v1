import { PlumbingLead, LeadInsert, LeadUpdate, reviewVisibleStatuses } from "@/data/leadModel";
import { fetchGoogleSheetLeads } from "@/lib/leads/googleSheets";
import { fetchLeadsFromDb, fetchLeadByIdFromDb, insertLeadToDb, updateLeadInDb, deleteLeadFromDb } from "@/lib/leads/supabase";

export type LeadDataSource = "supabase" | "google-sheets" | "mock-fallback";

/**
 * Google Sheets / mock fallback data has no tenant boundary. It only remains
 * as a bootstrap path for a tenant with zero rows in Supabase yet (e.g. during
 * initial onboarding before real leads exist) and must never be used to answer
 * a query for one tenant with another tenant's spreadsheet data.
 */
export async function getLeads(tenantId: string): Promise<{ leads: PlumbingLead[]; source: LeadDataSource; error?: boolean; message?: string }> {
  try {
    const dbLeads = await fetchLeadsFromDb(tenantId);
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

export async function getLeadById(id: string, tenantId: string) {
  try {
    const dbLead = await fetchLeadByIdFromDb(id, tenantId);
    if (dbLead) {
      return { lead: dbLead, source: "supabase" as const };
    }
  } catch (error) {
    console.error("[leads] Supabase fetch by id failed.", error);
  }

  const { leads, source } = await getLeads(tenantId);
  return { lead: leads.find((item) => item.id === id), source };
}

export async function createLead(lead: LeadInsert, tenantId: string) {
  return insertLeadToDb(lead, tenantId);
}

export async function updateLead(id: string, update: LeadUpdate, tenantId: string) {
  return updateLeadInDb(id, update, tenantId);
}

export async function deleteLead(id: string, tenantId: string) {
  return deleteLeadFromDb(id, tenantId);
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
    // P1B: open estimate dollars specifically needing attention — distinct
    // from revenuePipeline (which includes New/Contacted/Scheduled leads
    // with no estimate sent yet). See DOMAIN_MODEL.md / OUTCOME_ATTRIBUTION.md's
    // "AT-RISK ESTIMATE VALUE" vs "PIPELINE VALUE" distinction.
    atRiskEstimateValue: leads.filter((lead) => lead.status === "Estimate Sent").reduce((sum, lead) => sum + lead.estimateAmount, 0),
    reviewPending: leads.filter((lead) => lead.reviewRequestStatus === "Ready to Send").length,
    reviewVisibleStatuses,
  };
}
