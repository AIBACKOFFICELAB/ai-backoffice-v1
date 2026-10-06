import type { BusyInterval } from "../slots";

export type CalendarFailure = "SLOT_UNAVAILABLE" | "CALENDAR_UNAVAILABLE" | "CONFIGURATION_ERROR" | "INVALID_REQUEST" | "PROVIDER_ERROR";

export class CalendarError extends Error {
  constructor(public category: CalendarFailure, message: string = category) {
    super(message);
  }
}

export type ProviderEvent = { eventId: string; start: string; end: string; aiboBookingId: string | null };

/**
 * Provider-neutral calendar boundary. The voice model never sees this
 * interface's inputs/outputs directly — only normalized AIBO slots.
 */
export interface CalendarProvider {
  /** Busy intervals for [timeMin, timeMax) on one calendar. */
  getBusy(calendarId: string, timeMin: string, timeMax: string): Promise<BusyInterval[]>;
  /** Creates one event tagged with the AIBO booking id (private extended property). */
  createEvent(calendarId: string, input: { aiboBookingId: string; tenantId: string; start: string; end: string; timezone: string; summary: string }): Promise<ProviderEvent>;
  /** Finds an existing event carrying this AIBO booking id (retry reconciliation). */
  findByAiboBookingId(calendarId: string, aiboBookingId: string, timeMin: string, timeMax: string): Promise<ProviderEvent | null>;
  /** Events overlapping a window (post-write conflict verification). */
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<ProviderEvent[]>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}
