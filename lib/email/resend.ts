import { checkOutboundAllowed, OutboundContext } from "@/lib/execution/outboundGuard";

const RESEND_API_BASE = "https://api.resend.com";

export type SendEmailResult =
  | { ok: true; skipped: false }
  | { ok: false; skipped: true; reason: "missing-env" | "outbound-denied" }
  | { ok: false; skipped: false; reason: "resend-error" | "unexpected-error"; status?: number; detail?: string };

function getResendEnv() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;

  if (!apiKey || !fromEmail) {
    return { configured: false as const };
  }

  return { configured: true as const, apiKey, fromEmail };
}

/**
 * Generic single-recipient email send via Resend, shared by any module's
 * Execution layer. Never throws — a failed or unconfigured send returns a
 * result the caller must record in History, per
 * docs/constitution/03_MODULE_ARCHITECTURE.md (no channel fails silently).
 */
export async function sendEmail(
  toEmail: string,
  subject: string,
  textBody: string,
  ctx?: OutboundContext & {
    /** Fixed-content notice to the tenant's own operator-configured contact
     * (e.g. canonical intake "new request" alert). Not customer-facing, so it
     * is not subject to the Founder Beta outbound allowlist. */
    ownerNotice?: boolean;
  }
): Promise<SendEmailResult> {
  // Server-authoritative Founder Beta no-send boundary (see outboundGuard.ts).
  if (!ctx?.ownerNotice && !checkOutboundAllowed(ctx).allowed) {
    console.warn("[email] outbound send denied by server boundary", { tenantId: ctx?.tenantId ?? null });
    return { ok: false, skipped: true, reason: "outbound-denied" };
  }

  const env = getResendEnv();

  if (!env.configured) {
    console.warn("[email] Resend is not configured (RESEND_API_KEY/EMAIL_FROM). Skipping email send.");
    return { ok: false, skipped: true, reason: "missing-env" };
  }

  try {
    const response = await fetch(`${RESEND_API_BASE}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.fromEmail,
        to: [toEmail],
        subject,
        text: textBody,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[email] Resend send failed", { status: response.status, errorText });
      return { ok: false, skipped: false, reason: "resend-error", status: response.status, detail: errorText.slice(0, 500) };
    }

    return { ok: true, skipped: false };
  } catch (error) {
    console.error("[email] Unexpected error while sending email via Resend", error);
    return { ok: false, skipped: false, reason: "unexpected-error", detail: error instanceof Error ? error.message : String(error) };
  }
}
