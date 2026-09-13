import { NextResponse } from "next/server";
import { IntakeError, validateIntake } from "./validation";

const MAX_BODY_BYTES = 16384;
export async function readIntakeBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new IntakeError("UNSUPPORTED_MEDIA_TYPE", "Send a JSON service request.", 415);
  const origin = request.headers.get("origin");
  if (origin) {
    // Next/proxies may construct request.url using an internal hostname.
    // Browser Origin must match the actual incoming Host, not that internal URL.
    let sameHost = false;
    try {
      const parsed = new URL(origin);
      sameHost = ["http:", "https:"].includes(parsed.protocol) && parsed.host === (request.headers.get("host") ?? new URL(request.url).host);
    } catch { /* Invalid or opaque origins are refused. */ }
    if (!sameHost) throw new IntakeError("FORBIDDEN", "Unable to accept this request.", 403);
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new IntakeError("BODY_TOO_LARGE", "Service request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new IntakeError("INVALID_INPUT", "Provide a service request.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new IntakeError("BODY_TOO_LARGE", "Service request is too large.", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new IntakeError("INVALID_JSON", "Invalid JSON service request."); }
  validateIntake(raw); // Validate before tenant lookup / elevated DB access.
  return raw;
}
export function intakeFailure(error: unknown) {
  if (error instanceof IntakeError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  console.error("[intake] request failed; retry with the same submission identity");
  return NextResponse.json({ error: "We could not confirm your request. Please retry this same submission.", code: "INTAKE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
