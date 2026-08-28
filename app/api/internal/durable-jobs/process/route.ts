import { NextRequest, NextResponse } from "next/server";
import { processDueJobs } from "@/lib/execution/queue";
import { JOB_HANDLERS } from "@/lib/execution/handlers";

export const dynamic = "force-dynamic";

/**
 * Durable job queue poller (P0.6). Same authorization convention as the
 * existing Estimate Follow-up cron route
 * (app/api/modules/estimate-followup/trigger/route.ts) — Vercel Cron calls
 * this with GET and `Authorization: Bearer $CRON_SECRET`; it's also safe to
 * call manually (e.g. from an internal admin action) with the same header.
 */
function isAuthorizedCron(request: NextRequest): boolean {
  if (!process.env.CRON_SECRET) return false;
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const results = await processDueJobs(JOB_HANDLERS);
  return NextResponse.json({ ok: true, processed: results.length, results });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
