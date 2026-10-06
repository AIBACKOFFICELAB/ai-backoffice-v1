import { NextRequest, NextResponse } from "next/server";
import { handleVapiRequest } from "@/lib/integrations/vapi/handler";
import { createBookingStore, createRevenueDeskStore } from "@/lib/revenueDesk/store.server";
import { GoogleCalendarProvider } from "@/lib/revenueDesk/calendar/google";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const result = await handleVapiRequest(
      { body, contentType: request.headers.get("content-type"), headers: request.headers },
      { store: createRevenueDeskStore(), bookings: createBookingStore(), calendar: new GoogleCalendarProvider() },
      process.env.VAPI_WEBHOOK_SECRET
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[vapi] handler failure", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 500 });
  }
}
