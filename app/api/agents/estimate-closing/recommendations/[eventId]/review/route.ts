import { NextRequest } from "next/server";
import { handleReviewRequest } from "@/lib/agents/estimateClosing/reviewRoute";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, props: { params: Promise<{ eventId: string }> }) {
  const params = await props.params;
  return handleReviewRequest(request, params.eventId);
}
