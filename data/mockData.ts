export type Lead = {
  id: string;
  customerName: string;
  tradeType: string;
  serviceNeeded: string;
  source: string;
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
  { label: "Missed Leads", value: 14, trend: "+3 this week" },
  { label: "Follow-Ups Due", value: 22, trend: "8 overdue" },
  { label: "Open Estimates", value: 11, trend: "$42,600 pipeline" },
  { label: "Booked Jobs", value: 19, trend: "+5 vs last week" },
  { label: "Review Requests", value: 27, trend: "74% send rate" },
];

export const leads: Lead[] = [
  {
    id: "lead-1001",
    customerName: "Jason Miller",
    tradeType: "Plumbing",
    serviceNeeded: "Water heater replacement",
    source: "Google Local Services",
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
    source: "Website form",
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
    source: "Facebook ad",
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
    source: "Referral",
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
  "AI replied to 3 missed calls in under 2 minutes.",
  "Estimate sent to Jason Miller with financing options.",
  "Follow-up text queued for Marcus Lee at 8:15 AM.",
  "Review request sent after Sharon Patel's completed job.",
];

export const aiRecommendations = [
  "Call Angela Ruiz now: high urgency HVAC issue and no booking yet.",
  "Offer a same-week slot to Jason Miller to increase close rate.",
  "Send panel upgrade checklist to Marcus Lee before estimate call.",
];
