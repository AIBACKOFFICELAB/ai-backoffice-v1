const SENDGRID_API_BASE = "https://api.sendgrid.com/v3";

export type SendEmailResult =
  | { ok: true; skipped: false }
  | { ok: false; skipped: true; reason: "missing-env" }
  | { ok: false; skipped: false; reason: "sendgrid-error" | "unexpected-error"; status?: number; detail?: string };

function getSendgridEnv() {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;

  if (!apiKey || !fromEmail) {
    return { configured: false as const };
  }

  return { configured: true as const, apiKey, fromEmail };
}

/** Generic single-recipient email send, shared by any module's Execution layer. */
export async function sendEmail(toEmail: string, subject: string, textBody: string): Promise<SendEmailResult> {
  const env = getSendgridEnv();

  if (!env.configured) {
    console.warn("[email] SendGrid is not configured (SENDGRID_API_KEY/EMAIL_FROM). Skipping email send.");
    return { ok: false, skipped: true, reason: "missing-env" };
  }

  try {
    const response = await fetch(`${SENDGRID_API_BASE}/mail/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: env.fromEmail },
        subject,
        content: [{ type: "text/plain", value: textBody }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[email] SendGrid send failed", { status: response.status, errorText });
      return { ok: false, skipped: false, reason: "sendgrid-error", status: response.status, detail: errorText.slice(0, 500) };
    }

    return { ok: true, skipped: false };
  } catch (error) {
    console.error("[email] Unexpected error while sending email", error);
    return { ok: false, skipped: false, reason: "unexpected-error", detail: error instanceof Error ? error.message : String(error) };
  }
}
