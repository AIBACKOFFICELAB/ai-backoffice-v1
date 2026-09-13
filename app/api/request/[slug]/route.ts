import { NextResponse } from "next/server";
import { createCanonicalLeadFromIntake } from "@/lib/leads/intake/service";
import { createLiveIntakeDeps, resolvePublicIntakeTenant } from "@/lib/leads/intake/server";
import { intakeFailure, readIntakeBody } from "@/lib/leads/intake/http";
import { IntakeError } from "@/lib/leads/intake/validation";
export const dynamic = "force-dynamic";
export async function POST(request: Request, props: { params: Promise<{ slug: string }> }) {
  try {
    const raw = await readIntakeBody(request);
    const tenant = await resolvePublicIntakeTenant((await props.params).slug);
    if (!tenant) throw new IntakeError("NOT_FOUND", "Service request page not found.", 404);
    await createCanonicalLeadFromIntake(raw, tenant, "website_form", null, createLiveIntakeDeps());
    // No customer data, tenant ID, lead ID or dedupe existence oracle in public response.
    return NextResponse.json({ accepted: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return intakeFailure(error); }
}
