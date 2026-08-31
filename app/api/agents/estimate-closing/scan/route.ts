import { NextRequest } from "next/server";
import { handleScanRequest } from "@/lib/agents/estimateClosing/scanRoute";

export const dynamic = "force-dynamic";

/**
 * Vercel Cron entry point — see
 * lib/agents/estimateClosing/scanRoute.ts::handleScanRequest for the
 * actual auth/feature-gating/sweep logic (kept out of this file because
 * Next.js's App Router route.ts files may only export a fixed set of
 * names).
 */
export async function GET(request: NextRequest) {
  return handleScanRequest(request);
}
