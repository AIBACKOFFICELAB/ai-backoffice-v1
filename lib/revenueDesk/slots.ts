import { WEEKDAYS, type RevenueDeskConfig } from "./config";

export type BusyInterval = { start: string; end: string };
export type Slot = { slotId: string; start: string; end: string; timezone: string; durationMinutes: number };

/** Minutes offset of `tz` from UTC at instant `d` (e.g. -240 for EDT). */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** Wall-clock date+time in `tz` -> UTC Date (DST-correct via two-pass offset). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  const first = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(first), tz);
  return new Date(guess - off2 * 60000);
}

function localYmd(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday: get("weekday").toLowerCase().slice(0, 3) };
}

export function slotIdFor(start: string, durationMinutes: number): string {
  return `${start}|${durationMinutes}`;
}

/**
 * Deterministic candidate slots: inside operating hours (tenant timezone),
 * not overlapping any busy interval (padded by buffer), not in the past
 * (plus lead time), within the bounded day window. Never invents availability:
 * the caller must supply provider busy data for exactly this window.
 */
export function generateSlots(
  cfg: RevenueDeskConfig,
  opts: { now: Date; durationMinutes: number; busy: BusyInterval[]; days?: number; maxSlots?: number; leadTimeMinutes?: number; stepMinutes?: number }
): Slot[] {
  const days = Math.min(opts.days ?? 5, 14);
  const max = Math.min(opts.maxSlots ?? 3, 6);
  const step = opts.stepMinutes ?? 30;
  const earliest = opts.now.getTime() + (opts.leadTimeMinutes ?? 120) * 60000;
  const buf = cfg.bufferMinutes * 60000;
  const busy = opts.busy.map((b) => ({ s: Date.parse(b.start) - buf, e: Date.parse(b.end) + buf })).filter((b) => b.e > b.s);
  const out: Slot[] = [];

  for (let i = 0; i < days && out.length < max; i++) {
    const day = localYmd(new Date(opts.now.getTime() + i * 86400000), cfg.timezone);
    const wd = WEEKDAYS.find((w) => w === day.weekday);
    const hours = wd ? cfg.operatingHours[wd] : undefined;
    if (!hours) continue;
    const [oh, om] = hours.open.split(":").map(Number);
    const [ch, cm] = hours.close.split(":").map(Number);
    const open = zonedToUtc(day.y, day.m, day.d, oh, om, cfg.timezone).getTime();
    const close = zonedToUtc(day.y, day.m, day.d, ch, cm, cfg.timezone).getTime();
    for (let t = open; t + opts.durationMinutes * 60000 <= close && out.length < max; t += step * 60000) {
      const end = t + opts.durationMinutes * 60000;
      if (t < earliest) continue;
      if (busy.some((b) => t < b.e && end > b.s)) continue;
      const start = new Date(t).toISOString();
      out.push({ slotId: slotIdFor(start, opts.durationMinutes), start, end: new Date(end).toISOString(), timezone: cfg.timezone, durationMinutes: opts.durationMinutes });
      t += opts.durationMinutes * 60000 - step * 60000; // don't offer overlapping candidates
    }
  }
  return out;
}

/** Re-validates a caller-chosen slot against policy (hours/duration) — the model never decides eligibility. */
export function isSlotWithinPolicy(cfg: RevenueDeskConfig, startIso: string, durationMinutes: number, now: Date): boolean {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || start < now.getTime()) return false;
  const day = localYmd(new Date(start), cfg.timezone);
  const wd = WEEKDAYS.find((w) => w === day.weekday);
  const hours = wd ? cfg.operatingHours[wd] : undefined;
  if (!hours) return false;
  const [oh, om] = hours.open.split(":").map(Number);
  const [ch, cm] = hours.close.split(":").map(Number);
  const open = zonedToUtc(day.y, day.m, day.d, oh, om, cfg.timezone).getTime();
  const close = zonedToUtc(day.y, day.m, day.d, ch, cm, cfg.timezone).getTime();
  return start >= open && start + durationMinutes * 60000 <= close;
}
