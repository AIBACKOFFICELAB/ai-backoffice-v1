import { verifyVapiRequest, MAX_BODY_BYTES } from "./auth";
import { parseVapiMessage } from "./parse";
import { assistantContext, completeCall, handleToolCall, startOrResumeCall, transferDestination, type RevenueDeskDeps } from "@/lib/revenueDesk/service";

export type HttpResult = { status: number; body: Record<string, unknown> };

/**
 * Provider adapter: authenticate -> parse -> delegate to Revenue Desk domain
 * services. Contains no business policy. Tenant identity comes ONLY from the
 * trusted provider phone-number id resolved server-side.
 */
export async function handleVapiRequest(
  raw: { body: string; contentType: string | null; headers: { get(n: string): string | null } },
  deps: RevenueDeskDeps,
  secret: string | undefined
): Promise<HttpResult> {
  if (Buffer.byteLength(raw.body, "utf8") > MAX_BODY_BYTES) return { status: 413, body: { error: "payload too large" } };
  if (!raw.contentType?.toLowerCase().includes("application/json")) return { status: 415, body: { error: "unsupported content type" } };
  const auth = verifyVapiRequest(raw.body, raw.headers, secret);
  if (!auth.ok) {
    console.warn("[vapi] rejected request", { reason: auth.reason });
    return { status: 401, body: { error: "unauthorized" } };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.body);
  } catch {
    return { status: 400, body: { error: "malformed" } };
  }
  const msg = parseVapiMessage(json);
  if (!msg) return { status: 400, body: { error: "malformed" } };
  if (msg.kind === "ignored") return { status: 200, body: { ok: true } };

  const ctx = await startOrResumeCall(deps, msg.call);

  switch (msg.kind) {
    case "assistant-request": {
      // Unknown/disabled number: no business identity is revealed.
      if (!ctx) return { status: 200, body: { error: "This number is not available right now. Please try again later." } };
      const c = assistantContext(ctx.config);
      return { status: 200, body: { assistantOverrides: { firstMessage: c.greeting, variableValues: { businessName: c.businessName, serviceCategories: c.serviceCategories.join(", "), bookingAvailable: c.bookingAvailable, faqs: JSON.stringify(c.faqs) } } } };
    }
    case "tool-calls": {
      const results = [];
      for (const tc of msg.toolCalls) {
        const result = ctx
          ? await handleToolCall(deps, ctx, tc.name, tc.args, tc.id)
          : { ok: false, requiredAction: "escalate", reason: "tenant_unresolved", instruction: "Apologize; this line cannot take requests right now." };
        results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
      }
      return { status: 200, body: { results } };
    }
    case "transfer-destination-request": {
      const number = ctx ? await transferDestination(deps, ctx) : null;
      if (!number) return { status: 200, body: { error: "No transfer destination is available.", message: { type: "request-start", message: "I'm sorry, I can't transfer you right now. The team will call you back." } } };
      return { status: 200, body: { destination: { type: "number", number, message: "Connecting you to the team now." } } };
    }
    case "status-update":
      return { status: 200, body: { ok: true } };
    case "end-of-call-report":
      if (ctx) await completeCall(deps, ctx, msg);
      return { status: 200, body: { ok: true } };
  }
}
