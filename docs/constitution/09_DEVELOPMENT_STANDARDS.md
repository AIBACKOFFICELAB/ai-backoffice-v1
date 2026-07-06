# 09 — Development Standards

## Folder Structure

The existing App Router structure is the standard going forward. As modules are
added, they follow this convention:

```
app/
  api/
    modules/
      <module>/
        trigger/route.ts
        execute/route.ts
        status/route.ts
        analytics/route.ts
        history/route.ts
        settings/route.ts
  <module-page>/page.tsx        # UI surface for the module, if it has one
lib/
  <module>/
    repository.ts                # data access, following the leads/repository.ts pattern
    service.ts                   # Execution/Trigger business logic
    types.ts                     # module-local types
components/
  <module>/                      # module-scoped components
  shared/                        # cross-module UI primitives (cards, etc.)
db/
  migrations/
    NNN_description.sql          # sequential, never edited after merge
docs/
  constitution/                  # this directory — permanent, rarely changes
  modules/                       # per-module implementation docs (see below)
```

- `lib/<domain>/repository.ts` + `lib/<domain>/service.ts` split (data access vs.
  business logic) follows the precedent already established in
  `lib/leads/repository.ts` and `lib/leads/supabase.ts` — keep the split, don't
  collapse it for speed.
- Module-specific mock/fallback data, if needed during early Discovery/
  Configuration for a client, follows the same fallback-chain precedent as
  `data/plumbingLeads.ts` — but must be explicitly labeled as demo/fallback data
  in code, not left ambiguous.

## Naming Conventions

- Files: `camelCase.ts` for logic files, `PascalCase.tsx` for components,
  matching current repo convention (`LeadEditForm.tsx`, `repository.ts`).
- Database columns: `snake_case`, mapped to `camelCase` at the repository
  boundary (existing pattern in `lib/leads/supabase.ts` — preserve the mapping
  layer, never let snake_case leak into application/UI code).
- Module identifiers (route segments, table prefixes) use `kebab-case` /
  `snake_case` consistently: `missed-call-recovery` as a route segment,
  `missed_call_recovery_history` as a table name.
- No abbreviations that aren't already domain-standard (`sms`, `gc` for general
  contractor are acceptable; invented shorthand is not).

## Component Conventions

- Server components by default; `"use client"` only when interaction/state
  requires it — matching the existing correct split between `AppShell.tsx`
  (server) and `LeadEditForm.tsx`/`LeadStatusSelect.tsx` (client).
- No component is added without being used. Dead exports (like the current
  `PageTitle.tsx`) are removed in the same PR that would have introduced the
  next one, not left to accumulate.
- Shared UI primitives (cards, status badges, buttons) live in
  `components/shared/` once a second module needs them — do not let each module
  hand-roll its own card.

## Testing Requirements

- Every module ships with, at minimum: unit tests for its `service.ts` Execution
  logic (the highest-risk, highest-value layer to test) and an integration test
  for its `trigger` → `execute` → `history` path.
- API routes require at least one auth-rejection test (unauthenticated request
  returns 401) and one happy-path test per endpoint.
- No test suite currently exists in the repo — establishing one (framework
  choice, CI wiring) is a prerequisite task before the first MVP module ships,
  not a parallel nice-to-have.

## Documentation Requirements

- Every module gets a `docs/modules/<module>.md` file on completion, documenting
  its six layers (per [[03_MODULE_ARCHITECTURE]]), its Configuration schema, and
  its known limitations — following the documentation discipline already
  demonstrated in `AUTH_SETUP.md` and `DB_SCHEMA.md`.
- Schema changes are documented in `DB_SCHEMA.md` in the same PR as the
  migration, not after the fact.
- This `docs/constitution/` directory changes rarely and deliberately — see
  Article VIII of [[02_PRODUCT_CONSTITUTION]]. It is not the place for
  sprint-specific notes; those belong in `docs/modules/` or sprint planning
  artifacts.

## Deployment Standards

- Vercel remains the deployment target; environment variables follow the
  `.env.example` documentation pattern already established — every new required
  variable is added there in the same PR that introduces the dependency.
- `DEPLOYMENT_CHECKLIST.md`-style pre-flight checklists are required for any
  change touching auth, RLS, or billing — not just the original Sprint 1 auth
  rollout.
- CI (currently absent) must run lint + typecheck + tests on every PR before the
  first MVP module ships; this is a blocking prerequisite, not a follow-up task.
