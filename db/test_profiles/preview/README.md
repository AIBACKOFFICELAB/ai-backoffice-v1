# Local Preview security acceptance profile

This is a disposable PostgreSQL 17 fixture, not hosted migration tooling.
It reproduces the M006B/M006C Preview baseline and then applies the unchanged
H001 migration 028 locally. It does not access a Supabase project or repair a
migration ledger. Keep autonomous booking disabled.

## Exact inputs

`manifest.json` pins all input bytes and their order:

1. Original historical Supabase scaffold, then representative direct function
   and sequence default grants in `platform-defaults.sql`.
2. Canonical 001–007.
3. `008_preview.sql`: byte-for-byte sanitized 008 from the M006 recovery package,
   SHA-256 `0cb39ece06fef17daaae9374aae2c6e74099738ab16ab903d7edcf22ed29e268`.
4. `SEC-01.sql`: byte-for-byte frozen applied SEC-01 from the SEC-02 receipt,
   SHA-256 `99f84ab33f522edd3ed2c97be20a36bcec182d943d4aecf196a9fc0cd8a2b041`.
5. Canonical 009–027, followed by exact local H001 028.

Provenance: `AGIOS-Recovery/preview-migrations-wasugleumzcigegeuyua/`,
`MANIFEST.working-final.json`, `evidence/SEC-02/SEC-02_RECEIPT.md`, and
`evidence/M006B-026-027/M006B-026-027_RECEIPT.md`. The frozen SEC-01 file retains
its original draft comment; its execution is established by the receipt.
No original recovery artifact or canonical migration is modified here.

SEC-01 removes client table write privileges on future tables, while leaving
direct function defaults intact. H001 explicitly revokes client function
EXECUTE. Sequence defaults are representative; no H001 object needs a sequence.
This minimal scaffold does not emulate PostgREST, JWT authentication, hosted
extensions, or provider behavior, and is not proof of current hosted state.

## Reproduce

Use Node 22 and installed lockfile dependencies. Start a fresh disposable
PostgreSQL 17 database locally; for example:

```sh
docker run --detach --name aibo-r02-test --publish 127.0.0.1:55486:5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=aibo_test_preview \
  --tmpfs /var/lib/postgresql/data postgres:17
export DATABASE_URL=postgresql://postgres@127.0.0.1:55486/aibo_test_preview
npm run test:db:bootstrap
npx vitest run lib/revenueDesk lib/billing lib/testHarness/previewProfile.pg.test.ts
npm test
docker rm --force aibo-r02-test
```

Wait for PostgreSQL readiness before bootstrap. The bootstrap requires
localhost, a database named `aibo_test_*`, PostgreSQL 17, creator `postgres`,
no URL query options, and no pre-existing public relations or `auth.users`.
All hashes are checked before SQL executes. It refuses a second application;
dispose of the local container and create a fresh one rather than resetting
or patching migration history. Do not supply hosted credentials.

The shared acceptance suite expects SEC-01's explicit SQLSTATE `42501` for
denied writes. A separate positive test proves that lead UPDATE is still
authorized for an owner, while another tenant's lead is filtered to zero rows
by RLS. Those outcomes must not be conflated or accepted interchangeably.

`lib/revenueDesk/hardeningF01.pg.test.ts` deliberately retains its private
canonical 027→028 historical-upgrade database to exercise legacy backfill.
Its source and old scaffold remain unchanged except for a clarifying comment.
That historical database is not the shared final security acceptance profile.

CI's existing `test-db` job uses this same bootstrap on PostgreSQL 17 and runs
the full suite. The separate no-database job continues to report DB tests as
skipped; it cannot establish database acceptance. Future intentional migration
changes require a reviewed manifest update, not an unbounded SQL glob.
