import { NextRequest, NextResponse } from "next/server";
import { processDueFollowups, recordReplyForPhone } from "@/lib/modules/estimateFollowup/service";
import { findTenantByBusinessPhone } from "@/lib/modules/missedCallRecovery/service";

export const dynamic = "force-dynamic";

function isAuthorizedCron(request: NextRequest): boolean {
  if (!process.env.CRON_SECRET) return false;
  const authHeader = request.headers.get("authorization");
  const legacyHeader = request.headers.get("x-cron-secret");
  return authHeader === `Bearer ${process.env.CRON_SECRET}` || legacyHeader === process.env.CRON_SECRET;
}

/**
 * Twilio inbound SMS webhook (has "Body" + "From" + "To") — reply detection.
 * See docs/constitution/08_API_CONSTITUTION.md.
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await request.text());
    const from = params.get("From");
    const to = params.get("To");
    const body = params.get("Body");

    if (from && to && body !== null) {
      const settings = await findTenantByBusinessPhone(to);
      if (!settings) {
        return NextResponse.json({ ok: false, reason: "no-tenant-for-number" }, { status: 404 });
      }
      const result = await recordReplyForPhone(settings.tenantId, from);
      return NextResponse.json({ ok: true, fired: true, type: "reply", result });
    }
  }

  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const results = await processDueFollowups();
  return NextResponse.json({ ok: true, fired: true, type: "scan", processed: results.length, results });
}

/**
 * Vercel Cron calls scheduled jobs with GET and an `Authorization: Bearer
 * $CRON_SECRET` header — this is the time-based scan of all tenants' due
 * Day 1/3/7 steps.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const results = await processDueFollowups();
  return NextResponse.json({ ok: true, fired: true, type: "scan", processed: results.length, results });
}
