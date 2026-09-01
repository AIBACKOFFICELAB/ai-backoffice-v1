import { NextRequest } from "next/server";
import { handleApprovalDecision } from "@/lib/approvals/routeHandlers";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return handleApprovalDecision(request, params.id, "reject");
}
