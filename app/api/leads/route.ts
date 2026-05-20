import { NextResponse } from "next/server";
import { getLeads } from "@/lib/leads/repository";

export async function GET() {
  const { leads, source } = await getLeads();
  return NextResponse.json({ leads, source });
}
