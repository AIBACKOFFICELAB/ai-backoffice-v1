export type Lead = {
  id: string;
  customerName: string;
  tradeType: string;
  serviceNeeded: string;
  source: "Missed Call" | "Website Form" | "Facebook" | "Google Business Profile";
  urgency: "High" | "Medium" | "Low";
  status: "New" | "Contacted" | "Estimate Sent" | "Booked";
  lastMessage: string;
  phone: string;
  email: string;
  address: string;
  lastContactAt: string;
  estimateAmount: string;
  estimateStatus: "Draft" | "Sent" | "Approved" | "Declined";
};

export const dashboardStats = [
  { label: "Leads at Risk", value: 3, trend: "alpha week tracking", impact: "$900 still unclosed" },
  { label: "Follow-Ups Due Today", value: 2, trend: "same-day response target", impact: "prevent lead drop-off" },
  { label: "Open Estimates", value: 2, trend: "$900 active pipeline", impact: "close before week end" },
  { label: "Booked Jobs", value: 1, trend: "+1 emergency dispatch", impact: "$300 scheduled revenue" },
  { label: "Review Requests Sent", value: 0, trend: "pre-completion", impact: "not ready in alpha leads" },
];

export const leads: Lead[] = [
  {
    id: "lead-1001",
    customerName: "Rocky",
    tradeType: "Plumbing",
    serviceNeeded: "Leak detection",
    source: "Website Form",
    urgency: "Medium",
    status: "New",
    lastMessage: "Need this checked this week.",
    phone: "(813) 555-1174",
    email: "",
    address: "2219 W Cypress St, Tampa, FL",
    lastContactAt: "20 minutes ago",
    estimateAmount: "$0",
    estimateStatus: "Draft",
  },
];

export const recentActivity = [
  "Alpha lead captured from 5 Star Plumbing form and mapped to Lead Inbox.",
  "Follow-up reminder queued for same-week response SLA.",
  "Estimate tracking enabled for Property Manager and Owner records.",
  "Review workflow stays Not Ready until completed jobs are confirmed.",
];

export const aiRecommendations = [
  "Call Property Manager now to finalize same-day water heater estimate approval.",
  "Follow up with Owner on PRV estimate before Friday schedule fills.",
  "Confirm Rocky appointment window and tenant access details.",
];
