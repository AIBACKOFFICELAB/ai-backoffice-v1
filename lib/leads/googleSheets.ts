import { PlumbingLead } from "@/data/leadModel";

type SheetResponse = { values?: string[][] };

const SHEET_HEADERS = {
  timestamp: "Timestamp",
  customerName: "Customer Name",
  phone: "Phone Number (required for confirmation)",
  email: "Email Address (optional)",
  serviceAddress: "Service Address (Full Address)",
  propertyType: "Property Type",
  serviceNeeded: "Service Needed",
  emergency: "Is this an emergency?",
  urgency: "Urgency Level for Service",
  jobDescription: "Job Description",
  photosUploaded: "Photos Uploaded?",
  preferredAppointment: "Preferred Appointment Date/Time",
  customerRole: "Are you the owner, tenant, or property manager?",
  leadSource: "How did you find us?",
  customerNotes: "Additional Notes or Special Instructions",
  status: "Status",
  estimateAmount: "Estimate Amount",
  followUp: "Follow-Up",
  reviewRequestStatus: "Review Request Status",
  internalNotes: "Internal Notes",
} as const;

function normalizeBoolLike(value: string): "Yes" | "No" {
  return /^(yes|y|true|1)$/i.test(value.trim()) ? "Yes" : "No";
}

function safeNumber(value: string): number {
  const numeric = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

export function mapSheetRowsToLeads(rows: string[][]): PlumbingLead[] {
  if (!rows.length) return [];

  const [headerRow, ...dataRows] = rows;
  const headerIndex = Object.fromEntries(headerRow.map((name, index) => [name.trim(), index]));

  return dataRows
    .filter((row) => row.some((cell) => cell?.trim()))
    .map((row, index): PlumbingLead => {
      const read = (header: string) => row[headerIndex[header] ?? -1] ?? "";
      const date = read(SHEET_HEADERS.timestamp);

      return {
        id: `GS-${index + 1}-${Date.parse(date) || Date.now()}`,
        date: new Date(date).toISOString(),
        customerName: read(SHEET_HEADERS.customerName) || "Unknown Customer",
        phone: read(SHEET_HEADERS.phone),
        email: read(SHEET_HEADERS.email),
        serviceAddress: read(SHEET_HEADERS.serviceAddress),
        propertyType: (read(SHEET_HEADERS.propertyType) || "Other") as PlumbingLead["propertyType"],
        serviceType: (read(SHEET_HEADERS.serviceNeeded) || "Other") as PlumbingLead["serviceType"],
        emergency: normalizeBoolLike(read(SHEET_HEADERS.emergency)) as PlumbingLead["emergency"],
        urgency: (read(SHEET_HEADERS.urgency) || "Flexible") as PlumbingLead["urgency"],
        jobDescription: read(SHEET_HEADERS.jobDescription),
        photosUploaded: normalizeBoolLike(read(SHEET_HEADERS.photosUploaded)) as PlumbingLead["photosUploaded"],
        preferredAppointmentTime: read(SHEET_HEADERS.preferredAppointment),
        customerRole: (read(SHEET_HEADERS.customerRole) || "Other") as PlumbingLead["customerRole"],
        leadSource: (read(SHEET_HEADERS.leadSource) || "Other") as PlumbingLead["leadSource"],
        customerNotes: read(SHEET_HEADERS.customerNotes),
        status: (read(SHEET_HEADERS.status) || "New") as PlumbingLead["status"],
        estimateAmount: safeNumber(read(SHEET_HEADERS.estimateAmount)),
        followUpDate: read(SHEET_HEADERS.followUp),
        reviewRequestStatus: (read(SHEET_HEADERS.reviewRequestStatus) || "Not Ready") as PlumbingLead["reviewRequestStatus"],
        internalNotes: read(SHEET_HEADERS.internalNotes),
      };
    });
}

export async function fetchGoogleSheetLeads(): Promise<PlumbingLead[]> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const range = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:T";
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

  if (!spreadsheetId || !apiKey) {
    throw new Error("Google Sheets environment variables are not fully configured.");
  }

  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    next: { revalidate: 60 },
  });

  if (!response.ok) {
    throw new Error(`Google Sheets API request failed (${response.status}).`);
  }

  const payload = (await response.json()) as SheetResponse;
  return mapSheetRowsToLeads(payload.values ?? []);
}
