/**
 * Provider payload parsing ONLY — no business policy here. Vapi posts
 * `{ message: { type, call, ... } }` to the saved server URL.
 */
export type VapiCallRef = {
  providerCallId: string;
  providerPhoneNumberId: string | null;
  callerPhone: string | null;
  calledPhone: string | null;
  startedAt: string | null;
};

export type VapiMessage =
  | { kind: "assistant-request"; call: VapiCallRef }
  | { kind: "tool-calls"; call: VapiCallRef; toolCalls: Array<{ id: string; name: string; args: unknown }> }
  | { kind: "transfer-destination-request"; call: VapiCallRef }
  | { kind: "status-update"; call: VapiCallRef; status: string }
  | { kind: "end-of-call-report"; call: VapiCallRef; endedReason: string | null; durationSeconds: number | null; costUsd: number | null; startedAt: string | null; endedAt: string | null; transferred: boolean | null }
  | { kind: "ignored"; type: string };

const s = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function callRef(msg: Record<string, any>): VapiCallRef | null {
  const call = msg.call ?? {};
  const id = s(call.id, 100);
  if (!id) return null;
  return {
    providerCallId: id,
    providerPhoneNumberId: s(call.phoneNumberId ?? msg.phoneNumber?.id, 100),
    callerPhone: s(call.customer?.number ?? msg.customer?.number, 40),
    calledPhone: s(msg.phoneNumber?.number ?? call.phoneNumber?.number, 40),
    startedAt: s(call.startedAt ?? msg.startedAt, 40),
  };
}

export function parseVapiMessage(body: unknown): VapiMessage | null {
  const msg = (body as { message?: Record<string, any> })?.message;
  if (!msg || typeof msg.type !== "string") return null;
  const type = msg.type;
  const known = ["assistant-request", "tool-calls", "transfer-destination-request", "status-update", "end-of-call-report"];
  if (!known.includes(type)) return { kind: "ignored", type: type.slice(0, 40) };
  const call = callRef(msg);
  if (!call) return null;

  switch (type) {
    case "assistant-request":
      return { kind: "assistant-request", call };
    case "transfer-destination-request":
      return { kind: "transfer-destination-request", call };
    case "status-update":
      return { kind: "status-update", call, status: s(msg.status, 40) ?? "unknown" };
    case "tool-calls": {
      const list = (msg.toolCallList ?? msg.toolCalls ?? []) as any[];
      const toolCalls = list.slice(0, 5).flatMap((tc) => {
        const id = s(tc?.id, 100);
        const name = s(tc?.function?.name ?? tc?.name, 80);
        if (!id || !name) return [];
        let args: unknown = tc?.function?.arguments ?? tc?.arguments ?? {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = { __unparseable: true }; }
        }
        return [{ id, name, args }];
      });
      return { kind: "tool-calls", call, toolCalls };
    }
    default: {
      const ended = s(msg.endedAt ?? msg.call?.endedAt, 40);
      const started = s(msg.startedAt ?? msg.call?.startedAt, 40);
      const dur = n(msg.durationSeconds) ?? (ended && started ? (Date.parse(ended) - Date.parse(started)) / 1000 : null);
      const endedReason = s(msg.endedReason, 80);
      return {
        kind: "end-of-call-report",
        call,
        endedReason,
        durationSeconds: dur != null && dur >= 0 ? dur : null,
        costUsd: n(msg.cost) ?? n(msg.call?.cost),
        startedAt: started,
        endedAt: ended,
        transferred: endedReason ? /transfer/i.test(endedReason) && !/fail/i.test(endedReason) : null,
      };
    }
  }
}
