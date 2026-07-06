import { NextRequest, NextResponse } from "next/server";
import { executeMissedCallRecovery, findTenantByBusinessPhone } from "@/lib/modules/missedCallRecovery/service";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Public webhook Twilio calls on a missed call (StatusCallback with
 * CallStatus=no-answer/busy/failed). Not user-authenticated — Twilio itself
 * is the caller. Resolves the tenant by the "To" number, then hands off to
 * the Execution layer. See docs/constitution/08_API_CONSTITUTION.md.
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  let params: URLSearchParams;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await request.text());
  } else {
    const body = await request.json().catch(() => ({}));
    params = new URLSearchParams(body as Record<string, string>);
  }

  const callStatus = params.get("CallStatus") ?? "";
  const calledPhone = params.get("To") ?? "";
  const callerPhone = params.get("From") ?? "";
  const callSid = params.get("CallSid") ?? undefined;

  const missedStatuses = ["no-answer", "busy", "failed"];
  if (!missedStatuses.includes(callStatus)) {
    return NextResponse.json({ ok: true, fired: false, reason: "not-a-missed-call" });
  }

  if (!calledPhone || !callerPhone) {
    return NextResponse.json({ ok: false, fired: false, reason: "missing-phone-numbers" }, { status: 400 });
  }

  const settings = await findTenantByBusinessPhone(calledPhone);
  if (!settings) {
    return NextResponse.json({ ok: false, fired: false, reason: "no-tenant-for-number" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: tenantRow } = await supabase.from("tenants").select("name").eq("id", settings.tenantId).single();

  const result = await executeMissedCallRecovery(
    settings.tenantId,
    settings,
    { callerPhone, callSid, calledPhone, triggerSource: "twilio_missed_call" },
    tenantRow?.name ?? "our team"
  );

  return NextResponse.json({ ok: true, fired: true, result });
}
