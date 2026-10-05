import { NextRequest, NextResponse } from "next/server";
import { EmergencyLeadPayload, isEmergencyLead, sendOwnerEmergencySms } from "@/lib/sms/twilio";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext } from "@/lib/tenant";

export async function POST(request: NextRequest) {
  // Check authentication
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  let payload: EmergencyLeadPayload;

  try {
    payload = (await request.json()) as EmergencyLeadPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!isEmergencyLead(payload)) {
    return NextResponse.json({ ok: true, sent: false, reason: "not-emergency" });
  }

  const tenant = await getTenantContext();
  const smsResult = await sendOwnerEmergencySms(payload, { tenantId: tenant?.tenantId });

  if (smsResult.ok) {
    return NextResponse.json({ ok: true, sent: true, sid: smsResult.sid });
  }

  if (smsResult.skipped) {
    return NextResponse.json({ ok: true, sent: false, reason: smsResult.reason });
  }

  return NextResponse.json({ ok: false, sent: false, reason: smsResult.reason }, { status: 502 });
}
