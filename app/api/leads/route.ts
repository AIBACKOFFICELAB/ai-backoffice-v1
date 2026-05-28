import { NextResponse } from "next/server";
import { getLeads } from "@/lib/leads/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const { leads, source, error, message } = await getLeads();

  if (error) {
    return NextResponse.json({ error: true, message });
  }

  return NextResponse.json({ leads, source });
}
