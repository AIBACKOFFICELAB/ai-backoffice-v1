import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { LeadInsert, LeadUpdate, PlumbingLead } from "@/data/leadModel";

const tableName = "leads";

type LeadRow = {
  id: string;
  date: string;
  customer_name: string;
  phone: string;
  email: string | null;
  service_address: string;
  property_type: string;
  service_type: string;
  emergency: string;
  urgency: string;
  job_description: string;
  photos_uploaded: string;
  preferred_appointment_time: string | null;
  customer_role: string;
  lead_source: string;
  customer_notes: string | null;
  status: string;
  estimate_amount: string | number | null;
  follow_up_date: string | null;
  review_request_status: string;
  internal_notes: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  sms_sent_at: string | null;
};

function mapRowToLead(row: LeadRow): PlumbingLead {
  return {
    id: row.id,
    date: row.date,
    customerName: row.customer_name,
    phone: row.phone,
    email: row.email || "",
    serviceAddress: row.service_address,
    propertyType: row.property_type as PlumbingLead["propertyType"],
    serviceType: row.service_type as PlumbingLead["serviceType"],
    emergency: row.emergency as PlumbingLead["emergency"],
    urgency: row.urgency as PlumbingLead["urgency"],
    jobDescription: row.job_description,
    photosUploaded: row.photos_uploaded as PlumbingLead["photosUploaded"],
    preferredAppointmentTime: row.preferred_appointment_time || "",
    customerRole: row.customer_role as PlumbingLead["customerRole"],
    leadSource: row.lead_source as PlumbingLead["leadSource"],
    customerNotes: row.customer_notes || "",
    status: row.status as PlumbingLead["status"],
    estimateAmount: Number(row.estimate_amount ?? 0),
    followUpDate: row.follow_up_date || "",
    reviewRequestStatus: row.review_request_status as PlumbingLead["reviewRequestStatus"],
    internalNotes: row.internal_notes || "",
    source: row.source || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    smsSentAt: row.sms_sent_at,
  };
}

function mapLeadToRow(lead: LeadInsert): Partial<LeadRow> {
  return {
    id: lead.id || randomUUID(),
    date: lead.date,
    customer_name: lead.customerName,
    phone: lead.phone,
    email: lead.email || null,
    service_address: lead.serviceAddress,
    property_type: lead.propertyType,
    service_type: lead.serviceType,
    emergency: lead.emergency,
    urgency: lead.urgency,
    job_description: lead.jobDescription,
    photos_uploaded: lead.photosUploaded,
    preferred_appointment_time: lead.preferredAppointmentTime || null,
    customer_role: lead.customerRole,
    lead_source: lead.leadSource,
    customer_notes: lead.customerNotes || null,
    status: lead.status,
    estimate_amount: lead.estimateAmount,
    follow_up_date: lead.followUpDate || null,
    review_request_status: lead.reviewRequestStatus,
    internal_notes: lead.internalNotes || null,
    source: lead.source || null,
    created_at: lead.createdAt || new Date().toISOString(),
    updated_at: lead.updatedAt || new Date().toISOString(),
    sms_sent_at: lead.smsSentAt ?? null,
  };
}

export async function fetchLeadsFromDb(tenantId: string): Promise<PlumbingLead[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from(tableName).select("*").eq("tenant_id", tenantId);
  if (error) {
    throw new Error(error.message);
  }
  return (data as LeadRow[]).map(mapRowToLead);
}

export async function fetchLeadByIdFromDb(id: string, tenantId: string): Promise<PlumbingLead | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from(tableName).select("*").eq("id", id).eq("tenant_id", tenantId).single();
  if (error) {
    if (error.code === "PGRST116") {
      return null;
    }
    throw new Error(error.message);
  }
  return data ? mapRowToLead(data as LeadRow) : null;
}

export async function insertLeadToDb(lead: LeadInsert, tenantId: string): Promise<PlumbingLead> {
  const supabase = await createServerSupabaseClient();
  const row = { ...mapLeadToRow(lead), tenant_id: tenantId };
  const { data, error } = await supabase.from(tableName).insert(row).select().single();
  if (error) {
    throw new Error(error.message);
  }
  return mapRowToLead(data as LeadRow);
}

export async function updateLeadInDb(id: string, update: LeadUpdate, tenantId: string): Promise<PlumbingLead | null> {
  const supabase = await createServerSupabaseClient();
  const updateRow = {
    ...(update.date && { date: update.date }),
    ...(update.customerName && { customer_name: update.customerName }),
    ...(update.phone && { phone: update.phone }),
    ...(update.email !== undefined && { email: update.email || null }),
    ...(update.serviceAddress && { service_address: update.serviceAddress }),
    ...(update.propertyType && { property_type: update.propertyType }),
    ...(update.serviceType && { service_type: update.serviceType }),
    ...(update.emergency && { emergency: update.emergency }),
    ...(update.urgency && { urgency: update.urgency }),
    ...(update.jobDescription && { job_description: update.jobDescription }),
    ...(update.photosUploaded && { photos_uploaded: update.photosUploaded }),
    ...(update.preferredAppointmentTime !== undefined && { preferred_appointment_time: update.preferredAppointmentTime || null }),
    ...(update.customerRole && { customer_role: update.customerRole }),
    ...(update.leadSource && { lead_source: update.leadSource }),
    ...(update.customerNotes !== undefined && { customer_notes: update.customerNotes || null }),
    ...(update.status && { status: update.status }),
    ...(update.estimateAmount !== undefined && { estimate_amount: update.estimateAmount }),
    ...(update.followUpDate !== undefined && { follow_up_date: update.followUpDate || null }),
    ...(update.reviewRequestStatus && { review_request_status: update.reviewRequestStatus }),
    ...(update.internalNotes !== undefined && { internal_notes: update.internalNotes || null }),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from(tableName).update(updateRow).eq("id", id).eq("tenant_id", tenantId).select().single();
  if (error) {
    if (error.code === "PGRST116") {
      return null;
    }
    throw new Error(error.message);
  }
  return mapRowToLead(data as LeadRow);
}

export async function deleteLeadFromDb(id: string, tenantId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from(tableName).delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) {
    throw new Error(error.message);
  }
  return true;
}
