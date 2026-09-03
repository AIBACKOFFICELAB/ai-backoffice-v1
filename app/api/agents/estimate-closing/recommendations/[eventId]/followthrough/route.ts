import { NextRequest } from "next/server";
import { handleFollowThroughRequest } from "@/lib/agents/estimateClosing/followThroughRoute";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, props: { params: Promise<{ eventId: string }> }) {
  const params = await props.params;
  return handleFollowThroughRequest(request, params.eventId);
}
