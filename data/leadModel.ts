export type PropertyType =
  | "Single Family Home"
  | "Condo / Apartment"
  | "Commercial Property"
  | "Property Management Unit"
  | "Other";

export type ServiceType =
  | "Water Heater"
  | "Toilet Repair"
  | "Leak Detection"
  | "PRV Replacement"
  | "Drain Cleaning"
  | "Shower Valve"
  | "Faucet / Cartridge"
  | "Garbage Disposal"
  | "Emergency Plumbing"
  | "Property Management Work Order"
  | "Other";

export type EmergencyStatus = "Yes" | "No";
export type Urgency = "Emergency" | "Same Day" | "This Week" | "Flexible";
export type LeadStatus = "New" | "Contacted" | "Scheduled" | "Estimate Sent" | "Won" | "Lost" | "Completed";
export type ReviewRequestStatus = "Not Ready" | "Ready to Send" | "Sent" | "Review Received";
export type LeadSource = "Google" | "Website" | "Referral" | "Repeat Customer" | "Property Manager" | "Facebook" | "Instagram" | "Yelp" | "Other";
export type CustomerRole = "Owner" | "Tenant" | "Property Manager" | "Contractor / GC" | "Other";

export type PlumbingLead = {
  id: string;
  date: string;
  customerName: string;
  phone: string;
  email: string;
  serviceAddress: string;
  propertyType: PropertyType;
  serviceType: ServiceType;
  emergency: EmergencyStatus;
  urgency: Urgency;
  jobDescription: string;
  photosUploaded: "Yes" | "No";
  preferredAppointmentTime: string;
  customerRole: CustomerRole;
  leadSource: LeadSource;
  customerNotes: string;
  status: LeadStatus;
  estimateAmount: number;
  followUpDate: string;
  reviewRequestStatus: ReviewRequestStatus;
  internalNotes: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  smsSentAt?: string | null;
};

export type LeadInsert = Omit<PlumbingLead, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: string;
};

export type LeadUpdate = Partial<Omit<PlumbingLead, "id" | "createdAt" | "updatedAt" | "source" | "smsSentAt">>;

export const reviewVisibleStatuses: ReviewRequestStatus[] = ["Not Ready", "Ready to Send", "Sent", "Review Received"];
