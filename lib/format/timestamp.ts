/**
 * P1 Sprint 6 visual acceptance hotfix — a shared, dependency-free
 * formatter for rendering a persisted `occurredAt`/`created_at` instant as
 * concise, human-readable business UI text (e.g. Estimate Closing's
 * "Last durable scan" metric card), instead of the raw Postgres ISO string
 * (`2026-09-03T11:11:54.002556+00:00`) that was breaking that card's
 * compact layout.
 *
 * Deliberately does NOT introduce an Eastern-time (or any other
 * tenant-local) display convention: nothing in this codebase currently
 * establishes one (no existing `timeZone`/`America/New_York` usage
 * anywhere — grepped before adding this file), and inventing one here
 * would silently misrepresent when a UTC-stored instant actually
 * happened for whichever timezone the viewer is actually in. Formats in
 * UTC instead, explicitly labeled — the same zone the value is already
 * stored in, so the displayed instant is always exactly accurate, never
 * shifted, and deterministic for testing regardless of server/CI
 * timezone. A future sprint that establishes a real tenant/operator
 * display-timezone convention should update this formatter deliberately,
 * not have one guessed here.
 *
 * Zero imports of its own (mirrors followThroughTypes.ts's own "no
 * next/headers, safe in any bundle" discipline) — safe to import from
 * both a Server Component and a future Client Component alike.
 */

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
});

export type FormattedTimestamp = {
  /** Concise business-UI display value, e.g. "Sep 3, 2026 · 11:11 AM UTC". */
  display: string;
  /** The original, exact instant — always the true source value, suitable
   * for a `title`/tooltip attribute or other accessible secondary text. */
  title: string;
};

/**
 * Formats an ISO-8601 instant for compact display. Returns `null` for a
 * missing or malformed value — callers keep their own existing null-state
 * copy (e.g. "No telemetry yet") rather than this function ever fabricating
 * a placeholder date.
 */
export function formatOperationalTimestamp(isoTimestamp: string | null | undefined): FormattedTimestamp | null {
  if (!isoTimestamp) return null;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  return {
    display: `${DATE_FORMATTER.format(date)} · ${TIME_FORMATTER.format(date)} UTC`,
    title: isoTimestamp,
  };
}
