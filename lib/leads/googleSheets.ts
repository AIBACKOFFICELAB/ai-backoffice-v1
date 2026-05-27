import { createSign } from "node:crypto";
import { PlumbingLead } from "@/data/leadModel";

type SheetResponse = { values?: string[][] };

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

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

function safeIsoDate(value: string): string {
  const raw = value.trim();
  if (!raw) return new Date().toISOString();

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function createSignedJwt(clientEmail: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(privateKey).toString("base64url");
  return `${unsignedToken}.${signature}`;
}

async function getGoogleAccessToken(): Promise<string> {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY.");
  }

  const assertion = createSignedJwt(clientEmail, privateKey);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });

  const payload = (await tokenResponse.json()) as GoogleTokenResponse;

  if (!tokenResponse.ok || !payload.access_token) {
    throw new Error(`Failed to get Google access token (${tokenResponse.status}): ${payload.error ?? "unknown"} ${payload.error_description ?? ""}`.trim());
  }

  return payload.access_token;
}

export function mapSheetRowsToLeads(rows: string[][]): PlumbingLead[] {
  if (!rows.length) return [];

  const [headerRow, ...dataRows] = rows;
  const headerIndex = Object.fromEntries(headerRow.map((name, index) => [name.trim(), index]));

  return dataRows
    .filter((row) => row.some((cell) => cell?.trim()))
    .map((row, index): PlumbingLead => {
      const read = (header: string) => (row[headerIndex[header] ?? -1] ?? "").trim();
      const rawTimestamp = read(SHEET_HEADERS.timestamp);
      const safeDate = safeIsoDate(rawTimestamp);
      const parsedDate = Date.parse(rawTimestamp);
      const timestampForId = Number.isFinite(parsedDate) ? parsedDate : Date.now();

      return {
        id: `GS-${index + 1}-${timestampForId}`,
        date: safeDate,
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
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const range = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:T";

  if (!spreadsheetId) {
    throw new Error("Missing GOOGLE_SHEET_ID (or GOOGLE_SHEETS_SPREADSHEET_ID).");
  }

  const accessToken = await getGoogleAccessToken();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    next: { revalidate: 60 },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Sheets API request failed (${response.status}): ${detail}`);
  }

  const payload = (await response.json()) as SheetResponse;
  return mapSheetRowsToLeads(payload.values ?? []);
}
