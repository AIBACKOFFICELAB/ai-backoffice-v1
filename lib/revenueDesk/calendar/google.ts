import "server-only";
import { google, type calendar_v3 } from "googleapis";
import { CalendarError, type CalendarProvider, type ProviderEvent } from "./types";

/**
 * Google Calendar adapter (Founder Beta). Uses a DEDICATED Revenue Desk
 * service account (REVENUE_DESK_GOOGLE_SA_EMAIL / REVENUE_DESK_GOOGLE_SA_KEY),
 * deliberately NOT the legacy Google Sheets identity. The customer shares one
 * scheduling calendar with it; scope is limited to calendar events.
 */
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
const AIBO_PROP = "aiboBookingId";

function client(): calendar_v3.Calendar {
  const email = process.env.REVENUE_DESK_GOOGLE_SA_EMAIL;
  const key = process.env.REVENUE_DESK_GOOGLE_SA_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) throw new CalendarError("CONFIGURATION_ERROR", "calendar credentials not configured");
  const auth = new google.auth.JWT({ email, key, scopes: SCOPES });
  return google.calendar({ version: "v3", auth, timeout: 8000 });
}

function mapEvent(e: calendar_v3.Schema$Event): ProviderEvent | null {
  const start = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
  const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
  if (!e.id || !start || !end) return null;
  return { eventId: e.id, start: new Date(start).toISOString(), end: new Date(end).toISOString(), aiboBookingId: e.extendedProperties?.private?.[AIBO_PROP] ?? null };
}

/** Sanitizes provider failures into bounded categories (no stack traces leave this file). */
function wrap(err: unknown): never {
  if (err instanceof CalendarError) throw err;
  const status = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
  if (status === 403 || status === 404) throw new CalendarError("CONFIGURATION_ERROR", `calendar access ${status}`);
  if (status === 400) throw new CalendarError("INVALID_REQUEST", "calendar rejected request");
  throw new CalendarError("CALENDAR_UNAVAILABLE", "calendar provider unavailable");
}

export class GoogleCalendarProvider implements CalendarProvider {
  constructor(private readonly cal: () => calendar_v3.Calendar = client) {}

  async getBusy(calendarId: string, timeMin: string, timeMax: string) {
    try {
      const res = await this.cal().freebusy.query({ requestBody: { timeMin, timeMax, items: [{ id: calendarId }] } });
      const entry = res.data.calendars?.[calendarId];
      if (!entry || (entry.errors && entry.errors.length > 0)) throw new CalendarError("CONFIGURATION_ERROR", "calendar not accessible");
      return (entry.busy ?? []).filter((b) => b.start && b.end).map((b) => ({ start: b.start!, end: b.end! }));
    } catch (e) {
      wrap(e);
    }
  }

  async createEvent(calendarId: string, input: { aiboBookingId: string; tenantId: string; start: string; end: string; timezone: string; summary: string }) {
    try {
      const res = await this.cal().events.insert({
        calendarId,
        sendUpdates: "none", // never emails attendees
        requestBody: {
          summary: input.summary,
          start: { dateTime: input.start, timeZone: input.timezone },
          end: { dateTime: input.end, timeZone: input.timezone },
          extendedProperties: { private: { [AIBO_PROP]: input.aiboBookingId, aiboTenantId: input.tenantId } },
        },
      });
      const ev = mapEvent(res.data);
      if (!ev) throw new CalendarError("PROVIDER_ERROR", "provider returned no event id");
      return ev;
    } catch (e) {
      wrap(e);
    }
  }

  async findByAiboBookingId(calendarId: string, aiboBookingId: string, timeMin: string, timeMax: string) {
    try {
      const res = await this.cal().events.list({ calendarId, timeMin, timeMax, singleEvents: true, privateExtendedProperty: [`${AIBO_PROP}=${aiboBookingId}`] });
      const ev = (res.data.items ?? []).map(mapEvent).find((x) => x?.aiboBookingId === aiboBookingId);
      return ev ?? null;
    } catch (e) {
      wrap(e);
    }
  }

  async listEvents(calendarId: string, timeMin: string, timeMax: string) {
    try {
      const res = await this.cal().events.list({ calendarId, timeMin, timeMax, singleEvents: true, maxResults: 50 });
      return (res.data.items ?? []).filter((e) => e.status !== "cancelled" && e.transparency !== "transparent").map(mapEvent).filter((x): x is ProviderEvent => !!x);
    } catch (e) {
      wrap(e);
    }
  }

  async deleteEvent(calendarId: string, eventId: string) {
    try {
      await this.cal().events.delete({ calendarId, eventId, sendUpdates: "none" });
    } catch (e) {
      wrap(e);
    }
  }
}
