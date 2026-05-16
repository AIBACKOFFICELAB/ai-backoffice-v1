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
  { label: "Leads at Risk", value: 14, trend: "+3 in the last 7 days", impact: "$11,400 left on the table" },
  { label: "Follow-Ups Due Today", value: 22, trend: "8 overdue past 24 hours", impact: "Recover up to $6,200" },
  { label: "Open Estimates", value: 11, trend: "$42,600 active pipeline", impact: "$18,900 unclosed this week" },
  { label: "Booked Jobs", value: 19, trend: "+5 vs last week", impact: "$28,300 scheduled revenue" },
  { label: "Review Requests Sent", value: 27, trend: "74% send rate", impact: "12 new reviews this month" },
];

export const leads: Lead[] = [
  {
    id: "lead-1001",
    customerName: "Jason Miller",
    tradeType: "Plumbing",
    serviceNeeded: "Water heater replacement",
    source: "Missed Call",
    urgency: "High",
    status: "Estimate Sent",
    lastMessage: "Can you install before Friday?",
    phone: "(555) 103-9921",
    email: "jason.miller@email.com",
    address: "412 Birch Lane, Columbus, OH",
    lastContactAt: "18 minutes ago",
    estimateAmount: "$2,450",
    estimateStatus: "Sent",
  },
  {
    id: "lead-1002",
    customerName: "Angela Ruiz",
    tradeType: "HVAC",
    serviceNeeded: "AC not cooling",
    source: "Website Form",
    urgency: "High",
    status: "Contacted",
    lastMessage: "Unit is blowing warm air.",
    phone: "(555) 842-1019",
    email: "angela.ruiz@email.com",
    address: "90 Brookstone Dr, Tampa, FL",
    lastContactAt: "1 hour ago",
    estimateAmount: "$780",
    estimateStatus: "Draft",
  },
  {
    id: "lead-1003",
    customerName: "Marcus Lee",
    tradeType: "Electrical",
    serviceNeeded: "Panel upgrade",
    source: "Facebook",
    urgency: "Medium",
    status: "New",
    lastMessage: "Need quote for 200A upgrade.",
    phone: "(555) 710-6540",
    email: "marcus.lee@email.com",
    address: "1550 Walnut St, Denver, CO",
    lastContactAt: "3 hours ago",
    estimateAmount: "$3,900",
    estimateStatus: "Draft",
  },
  {
    id: "lead-1004",
    customerName: "Sharon Patel",
    tradeType: "Roofing",
    serviceNeeded: "Leak inspection",
    source: "Google Business Profile",
    urgency: "Low",
    status: "Booked",
    lastMessage: "Saturday morning works.",
    phone: "(555) 284-3005",
    email: "sharon.patel@email.com",
    address: "81 Lakeview Rd, Austin, TX",
    lastContactAt: "Yesterday",
    estimateAmount: "$1,150",
    estimateStatus: "Approved",
  },
];

export const recentActivity = [
  "AI answered 3 missed calls and captured all caller details before office hours.",
  "Estimate reminder sent to Jason Miller 4 hours after quote delivery.",
  "Follow-up text queued for Marcus Lee before end-of-day to prevent lead drop-off.",
  "Review request sent after Sharon Patel's completed roofing job.",
];

export const aiRecommendations = [
  "Call Angela Ruiz in the next 15 minutes: high urgency HVAC lead could book today.",
  "Offer Jason Miller a same-week install slot and financing to prevent quote shopping.",
  "Send Marcus Lee an estimate reminder now to recover $3,900 pipeline opportunity.",
];
