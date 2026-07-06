# 07 — UI Constitution

AI BackOffice adopts the Invoice Pilot Pro design language as its permanent visual
and interaction standard. This document defines the rules; it does not restate
Invoice Pilot Pro's design system token-by-token — where a concrete token value
(hex, spacing scale, font) is needed, it must be pulled from the Invoice Pilot Pro
repository/design system directly rather than re-guessed here, so the two never
drift apart silently.

## Core Direction: Dark Premium SaaS

- Default theme is dark. Home-service business owners are checking this app
  early morning, late at night, and on job sites in bright sunlight — a dark,
  high-contrast UI reads as "serious operational tool," not "consumer app," and
  performs better in variable lighting than a light theme.
- "Premium" means restrained, not decorative: no gradients-for-gradients'-sake,
  no illustration-heavy empty states, no playful copy in the product itself
  (playful copy belongs on the marketing site, not inside the operating tool).

## Minimal

- Every screen shows only what the user needs to make the next decision. No
  screen exists to "show off" data the user isn't currently acting on.
- Prefer omission over configuration: if a field or panel isn't needed for 80%+
  of users, it's hidden behind progressive disclosure, not shown by default.

## Fast

- Server components and static rendering by default (matching the existing
  Next.js App Router usage in `components/AppShell.tsx`); client components only
  where interaction requires it (as already done correctly in
  `LeadEditForm.tsx`, `LeadStatusSelect.tsx`).
- Optimistic UI updates for any in-place edit (status changes, quick actions) —
  the existing `LeadStatusSelect` optimistic-update-with-revert pattern is the
  house standard and should be replicated, not reinvented, in every new module.
- No loading spinners where a skeleton or optimistic state can be shown instead.

## Consistent Cards

- All record-list and record-detail surfaces (leads, jobs, invoices, proposals)
  use a shared card primitive: consistent padding, border, corner radius, and
  hover/focus state, regardless of which module owns the data.
- A card's anatomy is fixed: title/identifier, status indicator, key metadata
  row, action affordance. Modules do not invent their own card layout.

## Shared Typography

- One type scale, one font family, used identically across every module and
  every page. No module introduces its own heading size or font weight scale.
- Numeric/data-heavy displays (dashboard metrics, dollar amounts) use a
  consistent tabular-number treatment so figures align predictably across
  cards.

## Shared Spacing

- One spacing scale (matching Tailwind's default scale usage already present in
  the codebase) applied consistently — no module hardcodes arbitrary pixel
  values for margin/padding.
- Page-level layout (header height, content max-width, gutter) is owned by
  `AppShell.tsx` and inherited by every route; individual pages do not redefine
  outer layout.

## Shared Interaction Patterns

- Status changes: dropdown-in-place with optimistic update (established
  pattern).
- Destructive actions: always confirm, never single-click delete.
- Every module's Settings/Configuration surfaces (per
  [[03_MODULE_ARCHITECTURE]]) share one settings-page layout pattern — a user who
  has configured one module should immediately understand how to configure the
  next.
- Empty states are informative and action-oriented ("No follow-ups due today" +
  link to leads), never decorative illustrations.

## Enforcement

- New UI work is not "done" if it introduces a new card style, new spacing
  value, or new type scale not already in use elsewhere in the app. Divergence
  from this document requires an explicit, documented design decision, not a
  one-off implementation choice.
