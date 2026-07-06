const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export type EmergencyLeadPayload = {
  customerName?: string;
  phone?: string;
  serviceType?: string;
  serviceAddress?: string;
  urgency?: string;
  emergency?: string;
};

function normalize(value?: string) {
  return (value ?? "").trim();
}

export function isEmergencyLead(payload: EmergencyLeadPayload): boolean {
  const emergency = normalize(payload.emergency).toLowerCase();
  const urgency = normalize(payload.urgency).toLowerCase();

  return emergency === "yes" || urgency.includes("emergency");
}

export function buildEmergencySmsMessage(payload: EmergencyLeadPayload): string {
  return [
    "🚨 New Emergency Lead - 5 Star Plumbing",
    `Customer: ${normalize(payload.customerName) || "Unknown"}`,
    `Phone: ${normalize(payload.phone) || "Not provided"}`,
    `Service: ${normalize(payload.serviceType) || "Not provided"}`,
    `Address: ${normalize(payload.serviceAddress) || "Not provided"}`,
    `Urgency: ${normalize(payload.urgency) || "Not provided"}`,
  ].join("\n");
}

export type SendSmsResult =
  | { ok: true; skipped: false; sid?: string }
  | { ok: false; skipped: true; reason: "missing-env" }
  | { ok: false; skipped: false; reason: "twilio-error" | "unexpected-error"; status?: number };

/** Generic single-recipient SMS send, shared by every module's Execution layer. */
export async function sendSms(toPhone: string, message: string): Promise<SendSmsResult> {
  const env = getTwilioBaseEnv();

  if (!env.configured) {
    console.warn("[SMS] Twilio is not fully configured. Skipping SMS send.");
    return { ok: false, skipped: true, reason: "missing-env" };
  }

  const endpoint = `${TWILIO_API_BASE}/Accounts/${env.accountSid}/Messages.json`;
  const body = new URLSearchParams({
    To: toPhone,
    From: env.fromPhone,
    Body: message,
  });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.accountSid}:${env.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[SMS] Twilio send failed", { status: response.status, errorText });
      return { ok: false, skipped: false, reason: "twilio-error", status: response.status };
    }

    const result = (await response.json()) as { sid?: string };
    return { ok: true, skipped: false, sid: result.sid };
  } catch (error) {
    console.error("[SMS] Unexpected error while sending SMS", error);
    return { ok: false, skipped: false, reason: "unexpected-error" };
  }
}

function getTwilioBaseEnv() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromPhone) {
    return { configured: false as const };
  }

  return { configured: true as const, accountSid, authToken, fromPhone };
}

function getTwilioEnv() {
  const base = getTwilioBaseEnv();
  const toPhone = process.env.OWNER_ALERT_PHONE;

  if (!base.configured || !toPhone) {
    return { configured: false as const };
  }

  const { configured: _configured, ...baseFields } = base;
  return { configured: true as const, ...baseFields, toPhone };
}

export async function sendOwnerEmergencySms(payload: EmergencyLeadPayload) {
  const env = getTwilioEnv();

  if (!env.configured) {
    console.warn("[SMS] Twilio is not fully configured. Skipping SMS send.");
    return { ok: false as const, skipped: true as const, reason: "missing-env" as const };
  }

  const message = buildEmergencySmsMessage(payload);
  const endpoint = `${TWILIO_API_BASE}/Accounts/${env.accountSid}/Messages.json`;

  const body = new URLSearchParams({
    To: env.toPhone,
    From: env.fromPhone,
    Body: message,
  });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.accountSid}:${env.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[SMS] Twilio send failed", { status: response.status, errorText });
      return { ok: false as const, skipped: false as const, reason: "twilio-error" as const, status: response.status };
    }

    const result = (await response.json()) as { sid?: string };
    console.info("[SMS] Emergency owner alert sent", { sid: result.sid });

    return { ok: true as const, skipped: false as const, sid: result.sid };
  } catch (error) {
    console.error("[SMS] Unexpected error while sending Twilio SMS", error);
    return { ok: false as const, skipped: false as const, reason: "unexpected-error" as const };
  }
}
