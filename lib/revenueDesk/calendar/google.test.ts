import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GoogleCalendarProvider } from "./google";

describe("H001 Google evidence boundaries", () => {
  const event = { id: "ev", start: { dateTime: "2026-10-12T14:00:00Z" }, end: { dateTime: "2026-10-12T15:00:00Z" }, extendedProperties: { private: { aiboBookingId: "b" } } };
  function provider(data: Record<string, unknown>) {
    const list = vi.fn().mockResolvedValue({ data });
    return { list, cal: new GoogleCalendarProvider(() => ({ events: { list } }) as any) };
  }
  it("an incomplete overlap page cannot be accepted as a clear slot", async () => {
    const { cal } = provider({ items: [event], nextPageToken: "more" });
    await expect(cal.listEvents("cal", "start", "end")).rejects.toMatchObject({ category: "PROVIDER_ERROR" });
  });
  it.each([{ items: [event], nextPageToken: "more" }, { items: [event, { ...event,id:"dup" }] }])("ambiguous marker evidence is refused", async data => {
    await expect(provider(data).cal.findByAiboBookingId("cal","b","start","end")).rejects.toMatchObject({category:"PROVIDER_ERROR"});
  });
  it.each(["cancelled","transparent"])("%s event cannot confirm a booking", async kind => {
    const data={ items:[{...event, ...(kind === "cancelled" ? {status:kind} : {transparency:kind})}] };
    expect(await provider(data).cal.findByAiboBookingId("cal","b","start","end")).toBeNull();
  });
  it("a complete positive marker read returns normalized evidence without writing", async () => {
    const { cal,list }=provider({items:[event]});
    expect(await cal.findByAiboBookingId("cal","b","start","end")).toEqual({eventId:"ev",start:"2026-10-12T14:00:00.000Z",end:"2026-10-12T15:00:00.000Z",aiboBookingId:"b"});
    expect(list).toHaveBeenCalledTimes(1);
  });
});
