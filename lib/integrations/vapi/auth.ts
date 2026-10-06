import { createHmac, timingSafeEqual } from "crypto";

export const MAX_BODY_BYTES = 256 * 1024;
export const REPLAY_WINDOW_SECONDS = 300;

/**
 * Verifies a Vapi server request signed with a saved HMAC credential.
 * Configure the Vapi HMAC credential with: algorithm SHA256, signature
 * header VAPI_SIGNATURE_HEADER (default x-vapi-signature), timestamp header
 * VAPI_TIMESTAMP_HEADER (default x-vapi-timestamp), payload `${timestamp}.${body}`.
 * Signature may be hex or base64, optionally prefixed "sha256=".
 * Timestamp is REQUIRED (replay protection); missing secret -> reject all.
 */
export function verifyVapiRequest(
  rawBody: string,
  headers: { get(name: string): string | null },
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): { ok: true } | { ok: false; reason: "no-secret" | "missing-signature" | "missing-timestamp" | "stale" | "bad-signature" } {
  if (!secret) return { ok: false, reason: "no-secret" };
  const sigHeader = (process.env.VAPI_SIGNATURE_HEADER || "x-vapi-signature").toLowerCase();
  const tsHeader = (process.env.VAPI_TIMESTAMP_HEADER || "x-vapi-timestamp").toLowerCase();
  const sig = headers.get(sigHeader)?.trim().replace(/^sha256=/i, "");
  if (!sig) return { ok: false, reason: "missing-signature" };
  const ts = headers.get(tsHeader)?.trim();
  if (!ts || !/^\d{10,13}$/.test(ts)) return { ok: false, reason: "missing-timestamp" };
  const tsSeconds = ts.length === 13 ? Math.floor(Number(ts) / 1000) : Number(ts);
  if (Math.abs(nowSeconds - tsSeconds) > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "stale" };

  const mac = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest();
  const candidates = [Buffer.from(sig, /^[0-9a-f]+$/i.test(sig) ? "hex" : "base64")];
  return candidates.some((c) => c.length === mac.length && timingSafeEqual(c, mac)) ? { ok: true } : { ok: false, reason: "bad-signature" };
}
