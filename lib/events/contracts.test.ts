import { describe, it, expect } from "vitest";
import { getEventContract, EVENT_CONTRACTS } from "./contracts";
import { emitEvent } from "./service";
import { InMemoryBusinessEventStore } from "./store";

describe("event contracts (P0.9 Slice C, finding M-04)", () => {
  it("every registered contract has a positive schemaVersion and a stated idempotency policy", () => {
    for (const contract of Object.values(EVENT_CONTRACTS)) {
      expect(contract.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(["required", "recommended", "not_applicable"]).toContain(contract.idempotency);
    }
  });

  it("getEventContract returns null for an unregistered event type — not every type needs a contract", () => {
    expect(getEventContract("some.future.event")).toBeNull();
  });

  describe("PII minimization (finding H-05): raw callerPhone is rejected in every registered MCR event payload", () => {
    it.each(["call.missed", "lead.created", "recovery.sms_sent"])("%s rejects a payload containing callerPhone", (eventType) => {
      const contract = getEventContract(eventType)!;
      const result = contract.validatePayload({ callerPhone: "+15551234567" });
      expect(result.ok).toBe(false);
    });

    it.each(["call.missed", "lead.created", "recovery.sms_sent"])("%s accepts a privacy-safe payload", (eventType) => {
      const contract = getEventContract(eventType)!;
      expect(contract.validatePayload({ callSid: "CA123", triggerSource: "twilio_missed_call" }).ok).toBe(true);
    });
  });

  it("emitEvent (the governed path) throws when a payload violates its registered contract", async () => {
    const store = new InMemoryBusinessEventStore();
    await expect(emitEvent({ tenantId: "t1", eventType: "call.missed", payload: { callerPhone: "+15551234567" } }, store)).rejects.toThrow(
      /violates its registered contract/
    );
    expect(store.all()).toHaveLength(0);
  });

  it("emitEvent allows an unregistered event type through unchanged (no contract to enforce)", async () => {
    const store = new InMemoryBusinessEventStore();
    await expect(emitEvent({ tenantId: "t1", eventType: "some.future.event", payload: { anything: true } }, store)).resolves.toBeTruthy();
  });
});
