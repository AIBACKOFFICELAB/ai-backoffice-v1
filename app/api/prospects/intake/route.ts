import { NextRequest, NextResponse } from "next/server";
import { submitProspectIntake } from "@/lib/prospects/service";

export const dynamic = "force-dynamic";

/**
 * Public endpoint the landing page's "Book a Free Audit" form posts to.
 * Not tenant-scoped and not auth-gated — prospects aren't platform users
 * yet. This is the Discovery-stage entry point per
 * docs/constitution/04_SYSTEM_LIFECYCLE.md and the seam referenced in
 * docs/constitution/10_ROADMAP.md (Beta milestone).
 */
export async function POST(request: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const businessName = typeof payload.businessName === "string" ? payload.businessName.trim() : "";
  if (!businessName) {
    return NextResponse.json({ error: "businessName is required" }, { status: 400 });
  }

  try {
    const prospect = await submitProspectIntake({
      businessName,
      contactName: typeof payload.contactName === "string" ? payload.contactName : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      phone: typeof payload.phone === "string" ? payload.phone : undefined,
      businessType: typeof payload.businessType === "string" ? payload.businessType : undefined,
      message: typeof payload.message === "string" ? payload.message : undefined,
    });
    return NextResponse.json({ ok: true, prospectId: prospect.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
