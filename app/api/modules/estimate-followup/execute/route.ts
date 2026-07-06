import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { processDueFollowups } from "@/lib/modules/estimateFollowup/service";

export const dynamic = "force-dynamic";

/** Manual, authenticated re-run of the due-sequence scan (e.g. for testing during Activation). */
export async function POST(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const results = await processDueFollowups();
  return NextResponse.json({ processed: results.length, results });
}
