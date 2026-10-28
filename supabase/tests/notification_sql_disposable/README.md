# Disposable-database test for the Supply Chain notification SQL

Builds a throwaway PostgreSQL database from the real staging definitions
(`supabase/schemas/staging_schema.sql`, dumped 2026-10-26): the enums, the seven tables,
`queue_notification`, the current `trigger_document_notification` and every trigger on
`documents` (unrelated trigger functions are stubs with their real names). Then runs both
migrations against it. No network, no providers, no staging access.

1. Start any local PostgreSQL 16/17 and create a database `pre`.
2. Load `base_pre.sql`, then the extract (tables/enums/functions/constraints/triggers taken from
   the dump — see the notification docs for the extraction script), then `seed.sql`.
3. `bash run_tests.sh` (expects the server on socket /tmp port 55432, user postgres).

Last run: 37 passed, 0 failed (see docs/notifications/supply-chain-related-organization.md §8).
