import { NextResponse } from "next/server";
import { EmergencyLeadPayload, isEmergencyLead, sendOwnerEmergencySms } from "@/lib/sms/twilio";

export async function POST(request: Request) {
  let payload: EmergencyLeadPayload;

  try {
    payload = (await request.json()) as EmergencyLeadPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!isEmergencyLead(payload)) {
    return NextResponse.json({ ok: true, sent: false, reason: "not-emergency" });
  }

  const smsResult = await sendOwnerEmergencySms(payload);

  if (smsResult.ok) {
    return NextResponse.json({ ok: true, sent: true, sid: smsResult.sid });
  }

  if (smsResult.skipped) {
    return NextResponse.json({ ok: true, sent: false, reason: smsResult.reason });
  }

  return NextResponse.json({ ok: false, sent: false, reason: smsResult.reason }, { status: 502 });
}
