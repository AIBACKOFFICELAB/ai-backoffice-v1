# 08 — API Constitution

Every module (per [[03_MODULE_ARCHITECTURE]]) exposes exactly six API surfaces.
This mirrors the six architectural layers 1:1 and ensures no module can be
operated, debugged, or reported on through the UI alone — every capability is
also programmatically accessible, which is what allows future automation-of-
automation and third-party integration without redesign.

## The Six Endpoints

For a module named `<module>` (e.g. `missed-call-recovery`, `estimate-followup`,
`review-requests`), the standard route shape is:

```
/api/modules/<module>/trigger      POST    — Trigger layer
/api/modules/<module>/execute      POST    — Execution layer
/api/modules/<module>/status       GET     — current run/module status
/api/modules/<module>/analytics    GET     — Analytics layer
/api/modules/<module>/history      GET     — History layer
/api/modules/<module>/settings     GET/PUT — Configuration + Settings layers
```

### 1. Trigger Endpoint

Accepts an event that *may* cause the module to fire (e.g., "a call was
missed," "a lead crossed the follow-up threshold"). Responsible only for
evaluating whether Execution should run — logs the trigger evaluation (fired or
not, and why) regardless of outcome.

### 2. Execution Endpoint

Performs the module's actual work. May be called directly (e.g., by an
internal scheduler or by the Trigger endpoint) but must never be reachable
without auth, and must write a History row before returning.

### 3. Status Endpoint

Returns the current operational state of the module for a tenant: enabled/
paused, last successful run, last error, current Configuration summary. This is
what a health-check/monitoring job or support engineer hits first when a client
reports "the follow-ups stopped."

### 4. Analytics Endpoint

Returns the module's rolled-up metrics (per [[03_MODULE_ARCHITECTURE]] Analytics
layer): counts, rates, revenue-attributable figures, over a requested time
range. Powers both internal reporting and any client-facing dashboard metric.

### 5. History Endpoint

Returns the paginated, filterable raw event log for the module — the
programmatic counterpart to any "activity" UI. Must support filtering by
tenant, lead/job, date range, and outcome (success/failure).

### 6. Settings Endpoint

`GET` returns current Configuration + Settings for the tenant; `PUT` updates
them. This is the only endpoint allowed to mutate a module's Configuration —
Execution and Trigger endpoints read Configuration, they never write it.

## Cross-Cutting API Rules

- **Auth:** every endpoint enforces the existing `checkAuth()` pattern
  (`lib/api-auth.ts`) at minimum, extended with tenant-scoping once multi-tenant
  isolation lands (see [[06_DATABASE_PRINCIPLES]]).
- **Idempotency:** Execution and Trigger endpoints must be safe to call twice
  for the same event without double-firing (matching Article on Execution in
  [[03_MODULE_ARCHITECTURE]]).
- **Errors:** consistent error shape across every module — `{ error: string,
  code: string }` with correct HTTP status (400/401/404/409/500), following the
  precedent already set in `app/api/leads/route.ts`.
- **Dynamic rendering:** all module API routes are `export const dynamic =
  'force-dynamic'` by default, matching current leads API convention, unless a
  specific route has a deliberate, documented caching strategy.
- **Versioning:** breaking changes to a module's endpoint contract require a
  new module version path segment (e.g. `/api/modules/v2/<module>/...|`) rather
  than silently changing the existing contract underneath integrators.

## Why Six, Always

A module that only ships `execute` (the common shortcut) cannot be monitored,
cannot be reported on, and cannot be safely paused — which is exactly the
failure mode Article V and Article VI of the
[[02_PRODUCT_CONSTITUTION]] exist to prevent. The API surface is the
programmatic proof that a module satisfies the full architecture, not just its
headline feature.
