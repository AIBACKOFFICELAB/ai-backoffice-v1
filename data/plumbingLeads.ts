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
  status: LeadStatus;
  estimateAmount: number;
  followUpDate: string;
  reviewRequestStatus: ReviewRequestStatus;
  notes: string;
};

export const plumbingLeads: PlumbingLead[] = [
  {
    id: "L-5001",
    date: "2026-05-19T08:31:00Z",
    customerName: "Jason Miller",
    phone: "+1 (555) 103-9921",
    email: "jason.miller@email.com",
    serviceAddress: "412 Birch Lane, Columbus, OH 43215",
    propertyType: "Single Family Home",
    serviceType: "Water Heater",
    emergency: "Yes",
    urgency: "Emergency",
    jobDescription: "Water heater burst overnight, basement flooding, needs immediate replacement.",
    photosUploaded: "Yes",
    preferredAppointmentTime: "Today 1:00 PM - 3:00 PM",
    customerRole: "Owner",
    leadSource: "Google",
    status: "New",
    estimateAmount: 0,
    followUpDate: "2026-05-19",
    reviewRequestStatus: "Not Ready",
    notes: "Requested confirmation by phone within 10 minutes.",
  },
  {
    id: "L-5002",
    date: "2026-05-19T10:05:00Z",
    customerName: "Angela Ruiz",
    phone: "+1 (555) 842-1019",
    email: "angela.ruiz@email.com",
    serviceAddress: "90 Brookstone Dr, Tampa, FL 33602",
    propertyType: "Condo / Apartment",
    serviceType: "Toilet Repair",
    emergency: "No",
    urgency: "Same Day",
    jobDescription: "Main bathroom toilet keeps running and overflows occasionally.",
    photosUploaded: "No",
    preferredAppointmentTime: "Today after 4:30 PM",
    customerRole: "Tenant",
    leadSource: "Website",
    status: "Estimate Sent",
    estimateAmount: 780,
    followUpDate: "2026-05-20",
    reviewRequestStatus: "Not Ready",
    notes: "Estimate emailed; waiting for landlord approval.",
  },
  {
    id: "L-5003",
    date: "2026-05-18T14:42:00Z",
    customerName: "Marcus Lee",
    phone: "+1 (555) 710-6540",
    email: "marcus.lee@email.com",
    serviceAddress: "1550 Walnut St, Denver, CO 80202",
    propertyType: "Commercial Property",
    serviceType: "PRV Replacement",
    emergency: "No",
    urgency: "This Week",
    jobDescription: "Pressure is too high in multi-tenant unit; needs PRV replaced this week.",
    photosUploaded: "Yes",
    preferredAppointmentTime: "Thursday 9:00 AM",
    customerRole: "Property Manager",
    leadSource: "Property Manager",
    status: "Scheduled",
    estimateAmount: 3900,
    followUpDate: "2026-05-21",
    reviewRequestStatus: "Ready to Send",
    notes: "Tenant access confirmed. Parking instructions sent.",
  },
  {
    id: "L-5004",
    date: "2026-05-17T09:15:00Z",
    customerName: "Sharon Patel",
    phone: "+1 (555) 284-3005",
    email: "sharon.patel@email.com",
    serviceAddress: "81 Lakeview Rd, Austin, TX 78701",
    propertyType: "Single Family Home",
    serviceType: "Leak Detection",
    emergency: "No",
    urgency: "Flexible",
    jobDescription: "Intermittent slab leak signs near kitchen island.",
    photosUploaded: "No",
    preferredAppointmentTime: "Any weekday morning",
    customerRole: "Owner",
    leadSource: "Referral",
    status: "Completed",
    estimateAmount: 1150,
    followUpDate: "2026-05-17",
    reviewRequestStatus: "Sent",
    notes: "Job completed. Waiting on customer review.",
  },
  {
    id: "L-5005",
    date: "2026-05-16T16:20:00Z",
    customerName: "Carlos Diaz",
    phone: "+1 (555) 693-2114",
    email: "",
    serviceAddress: "2401 Pine Ave, Sacramento, CA 95814",
    propertyType: "Property Management Unit",
    serviceType: "Drain Cleaning",
    emergency: "Yes",
    urgency: "Emergency",
    jobDescription: "Kitchen line backup affecting two units.",
    photosUploaded: "Yes",
    preferredAppointmentTime: "ASAP",
    customerRole: "Property Manager",
    leadSource: "Repeat Customer",
    status: "Won",
    estimateAmount: 2200,
    followUpDate: "2026-05-19",
    reviewRequestStatus: "Review Received",
    notes: "Repeat client. Prioritize on dispatch board.",
  },
];

export const reviewVisibleStatuses: ReviewRequestStatus[] = ["Ready to Send", "Sent", "Review Received"];
