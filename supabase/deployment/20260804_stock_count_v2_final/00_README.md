# Stock Count V2 / Inventory Opening Balance — final SQL deployment pack

## 1. Purpose

Bring a database up to the **exact database contract required by the authoritative
application code**, without replaying 55 development migrations in which later files
repeatedly fixed, renamed and superseded earlier ones.

This pack is **not** a concatenation of the old migrations. Every object is installed
once, in dependency order, at its **final** definition. Superseded intermediate
versions are never applied.

## 2. Authoritative application commit

```
9a62556aae6f64af3bc98f159196179669311b3f
```

All SQL bodies are copied **verbatim** from the migration that holds each object's
final ("last writer") definition, or — for the preview delegation chain — exported
with `pg_get_functiondef()` from staging, which the audit proved byte-equivalent to
those same migrations. **No PL/pgSQL logic was rewritten, redesigned or reinterpreted.**

## 3. Supported environments

Self-hosted Supabase / PostgreSQL 17.x. One state-aware pack serves both
environments; it detects what is already present and installs only what is missing.

| Environment | State at audit time | Recommended path |
|---|---|---|
| **Staging** | **37/37 contract functions present and correct** | **Path A — verification only (`01`, `08`, `09`)** |
| **Production** | 1 correct, 28 missing, 8 outdated | **Path B — full deployment (`01`–`09`)** |

### ⚠ Staging does NOT need files 02–07

Staging already matches the contract exactly. Running `02`–`07` there would be a
no-op *except* for the grant hardening in `07`, which is a genuine change. Do not
run them "for rehearsal" — use **Path A** and only fall back to Path B if `08`
reports a FAIL.

## 4. Execution order

Run **in this exact order**. Do not skip. Do not reorder.

| # | File | Type | Transactional |
|---|---|---|---|
| 00a | `00_PhaseA_inspect_counting_cutoff.sql` | 🔍 READ-ONLY | read-only txn |
| 00b | `00_PhaseB_cancel_counting_cutoff.sql` | ✏️ **DATA CHANGE** | txn, ROLLBACK by default |
| 00c | `00_PhaseC_verify_counting_cutoff.sql` | 🔍 READ-ONLY | read-only txn |
| 01 | `01_preflight_read_only.sql` | 🔍 READ-ONLY | read-only txn |
| 02 | `02_schema_foundation.sql` | 🏗 SCHEMA CHANGE | single txn |
| 03 | `03_constraints_and_indexes.sql` | 🏗 SCHEMA CHANGE | single txn ⚠ locks |
| 04 | `04_functions_and_triggers.sql` | 🏗 SCHEMA CHANGE | single txn |
| 05 | `05_rls_policies_and_grants.sql` | 🏗 SCHEMA CHANGE | single txn |
| 06a | `06_PhaseA_reconciliation_preview.sql` | 🔍 READ-ONLY | read-only txn |
| 06b | `06_PhaseB_reconciliation_apply.sql` | ✏️ **DATA CHANGE** | txn, ROLLBACK by default |
| 07 | `07_final_contract_fixes.sql` | 🏗 SCHEMA CHANGE | single txn |
| 08 | `08_post_deployment_verification.sql` | ✅ VERIFICATION ONLY | read-only txn |
| 09 | `09_operational_smoke_checks_read_only.sql` | ✅ VERIFICATION ONLY | read-only txn |

The `00_*` files are only needed when `01` reports an Opening Balance cut-off
still in status `counting`. Run them **before** `02`.

**No file in this pack uses psql backslash meta-commands**, so every one of them
runs unchanged in psql, Supabase Studio, DBeaver or pgAdmin. The two files that
change data (`00_PhaseB`, `06_PhaseB`) end in `ROLLBACK`: run once, read the
output, then swap `ROLLBACK` for the commented `COMMIT` and run again.

### 5. Read-only files (safe to run any time, including on production)

`01`, `08`, `09`. Each opens `BEGIN READ ONLY`, so the engine itself rejects writes.

### 6. Files that change schema

`02`, `03`, `04`, `05`, `07`. These create tables, constraints, indexes, functions,
triggers, policies and grants. **None of them read or write business rows.**

### 7. Files that may update existing data

**`06_PhaseB_reconciliation_apply.sql` only.** It performs exactly two `UPDATE`s:

1. `inventory_stock_configurations.status` → `'inactive'` where the owning
   `product_variants` row is already archived (`is_active = false`).
2. `stock_count_sessions.status` → `'archived'` for opening-balance drafts whose
   only cut-off is already `'cancelled'`.

It does **not** touch inventory quantities, stock movements, orders, QR records or
posted Opening Balances. It never replays a movement or backfills a business
transaction twice. Both statements are naturally idempotent.

`06_PhaseA_reconciliation_preview.sql` is the **read-only preview**: it shows the
exact rows each change would touch and emits `SAFE_TO_APPLY` / `NOT_SAFE` /
`NOTHING_TO_DO`. Run it first. `06_PhaseB` refuses to run while any ambiguity
count is non-zero unless you deliberately set `ambiguity_override`.

## 8. Backup requirement — mandatory

**Take a full database backup immediately before step 02 and confirm it is
restorable.** For several steps in this pack, restoring that backup is the *only*
reliable recovery path. See `ROLLBACK_AND_RECOVERY.md`.

Do not rely on a backup you have not verified.

## 9. Expected output

| File | Expected |
|---|---|
| 01 | `OVERALL_STATUS` = `PASS` or `REVIEW_REQUIRED`. Every `FAIL` is a stop condition. |
| 02 | `CREATE TABLE` / `CREATE INDEX` notices, or `already exists, skipping` on re-run |
| 03 | `ALTER TABLE`, `CREATE INDEX`. Aborts loudly if duplicate rows would break the index. |
| 04 | a long run of `CREATE FUNCTION` / `CREATE TRIGGER` |
| 05 | `ALTER TABLE`, `CREATE POLICY`, `GRANT`, `REVOKE` |
| 06a | preview + ambiguity counts + a `decision` column. Read-only. |
| 06b | applies the two `UPDATE`s, then **ROLLBACK**. Swap for the commented `COMMIT` to persist. Both staging and production currently report **0 qualifying rows**, so it is expected to be a no-op. |
| 07 | 6 × `CREATE FUNCTION`, then one `DO` (the grant hardening). **Run as `supabase_admin`.** |
| 08 | `OVERALL_STATUS` = **`PASS`**, `FAIL_COUNT` = 0, `REVIEW_REQUIRED_COUNT` = 0 |
| 09 | `READY_FOR_UI_TESTING` = `YES`, `BLOCKER_COUNT` = 0 |

## 10. Stop conditions

Stop immediately and do not continue if:

- `01` reports `OVERALL_STATUS = FAIL` — a mandatory prerequisite is missing.
- `01` reports duplicate `(session_id, stock_config_id)` rows — `03` would fail.
- `01` reports `stock_movements.reference_type` values outside the allowlist — `03` would fail.
- `01` reports ambiguous overloads — PostgREST cannot resolve the RPC.
- Any file reports an error. **Do not run the next file.** Do not re-run the failed
  file "to see if it works this time" — read `ROLLBACK_AND_RECOVERY.md` first.
- `08` reports any `FAIL`.
- `09` reports any `BLOCKER`.

## 11. Recovery

See `ROLLBACK_AND_RECOVERY.md`. Short version: every file is a single transaction,
so a mid-file failure rolls itself back. `06_PhaseB` and `00_PhaseB` change data —
which is why the backup is mandatory and why both default to `ROLLBACK`.

## 12. Staging execution procedure

### Path A — verification only (RECOMMENDED, based on current evidence)

```bash
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 01_preflight_read_only.sql
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 08_post_deployment_verification.sql
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 09_operational_smoke_checks_read_only.sql
```

All three are read-only. If `08` reports `FAIL_COUNT = 0`, staging is already
correct and **nothing further is needed** — except the one deliberate change
below.

> **The single exception — and it needs `supabase_admin`.** `08` will FAIL on the
> anon/PUBLIC grant checks, because staging still carries the inherited grants.
> Closing them means running `07`, which is safe standalone (`CREATE OR REPLACE`
> plus `REVOKE`/`GRANT`; it touches no data).
>
> ⚠️ **`07` must be run as `supabase_admin`.** Every function it replaces or
> re-grants is owned by `supabase_admin`, and both `CREATE OR REPLACE FUNCTION`
> and `REVOKE`/`GRANT` require ownership. Running as `postgres` fails on the very
> first statement with `must be owner of function inventory_cutoff_preview` — the
> whole file is one transaction, so nothing is applied. No ownership change, role
> membership change, password change or HBA change is required: just connect as
> the owner.

### Path B — full deployment (only if Path A shows staging is incomplete)

```bash
# 0. take and verify a backup first
# 1. preflight
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 01_preflight_read_only.sql
# review OVERALL_STATUS before continuing

# 2. schema + contract
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 02_schema_foundation.sql
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 03_constraints_and_indexes.sql
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 04_functions_and_triggers.sql
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 05_rls_policies_and_grants.sql

# 3. data reconciliation -- preview first, then apply
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 06_PhaseA_reconciliation_preview.sql
# Only if PhaseA reports SAFE_TO_APPLY:
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 06_PhaseB_reconciliation_apply.sql
# PhaseB ends in ROLLBACK. Swap it for the commented COMMIT to persist.

# 4. terminal contract
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 07_final_contract_fixes.sql

# 5. verify
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 08_post_deployment_verification.sql
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f 09_operational_smoke_checks_read_only.sql
```

Use Path B on staging only if Path A proved it incomplete.

## 13. Staging verification and UI testing

1. `08` must report `FAIL_COUNT = 0`.
2. `09` must report `READY_FOR_UI_TESTING = YES`.
3. If a newly created RPC returns 404 from the app, restart the PostgREST/Kong
   container once. The pack issues `NOTIFY pgrst, 'reload schema'`, but a
   self-hosted stack sometimes needs the restart. This is not a SQL failure.
4. Then test in the UI: create an Opening Balance draft → Save Draft → D2H policy →
   H2M policy → Transactions policy → preview → request OTP → post → confirm
   View Inventory and Movement History refresh → confirm cancellation lives in the
   Danger Zone.

## 14. Production execution procedure

> ### ⛔ DO NOT RUN ON PRODUCTION UNTIL STAGING HAS BEEN TESTED AND APPROVED.
>
> Production is materially behind staging (8 tables, 26 functions, 2 CHECK values
> and 1 trigger missing). The production run is a **real install**, not a no-op.

When approved, the sequence is identical to §12 against the production URL, plus:

- **No maintenance window is required.** Measured read-only on production:
  `stock_movements` holds **2,945 rows / 864 kB**, so step `03`'s `ACCESS EXCLUSIVE`
  lock lasts milliseconds. (An earlier draft over-warned about this.)
- Take a fresh, verified backup immediately before starting.
- Run `01` on production first and read every `REVIEW_REQUIRED` row — production
  has years of real data that staging does not.
- Run the `06` preview and have someone confirm the row counts are plausible
  **before** applying it.

## 15. Manual checklist

```
[ ] Read this README end to end
[ ] Full database backup taken
[ ] Backup restore VERIFIED (not just taken)
[ ] Staging path chosen:  A (verification only)  /  B (full deploy)
[ ] 01 preflight run -- OVERALL_STATUS recorded: ______________
[ ] Every FAIL from 01 resolved
[ ] Every REVIEW_REQUIRED from 01 read and accepted
[ ] 02 schema foundation      -- completed / errors: ______________
[ ] 03 constraints & indexes  -- completed / errors: ______________
[ ] 04 functions & triggers   -- completed / errors: ______________
[ ] 05 RLS, policies, grants  -- completed / errors: ______________
[ ] 06 PREVIEW counts reviewed -- configs: ______  sessions: ______
[ ] 06 ambiguity counts all zero?                    ______________
[ ] 06_PhaseA reviewed; 06_PhaseB committed (only if needed)
[ ] 07 final contract fixes   -- completed / errors: ______________
[ ] 08 verification -- FAIL_COUNT = 0 ?               ______________
[ ] 09 smoke checks -- READY_FOR_UI_TESTING = YES ?   ______________
[ ] PostgREST/Kong restarted if any RPC 404s
[ ] UI test on STAGING passed and approved
[ ] Production run explicitly authorised by: ______________
```

## 16. ⚠ Do not blindly re-run after a failure

If a file fails partway:

1. **Read the error.** Do not immediately re-run.
2. Files `02`–`07` are each wrapped in a single transaction. A failure rolls the
   whole file back, so the database is at the state it had *before* that file. In
   that case re-running after fixing the cause is correct.
3. **But** if the client was disconnected, the session was killed, or the server
   restarted mid-file, you cannot assume a clean rollback. Verify with `01` and `08`
   before doing anything else.
4. Never edit a pack file to "skip past" a failing statement. That produces exactly
   the kind of half-applied state this pack exists to eliminate.

## 16b. Final client-role grants (enforced by `07`, verified by `08`)

| Role | EXECUTE on the Stock Count V2 / Opening Balance surface |
|---|---|
| `PUBLIC` | **none** |
| `anon` | **none** |
| `authenticated` | **application entry points only** (22) |
| `service_role` | **application entry points only** (22) |
| `*_pre_*` delegation layers | **no direct client execution** |
| trigger functions | **no direct client execution** |
| helpers / guards | **no direct client execution** |

The surface covers the Opening Balance cut-off functions **and** the Stock Count V2
verification/discard boundary — `prepare_stock_count_verification`,
`discard_stock_count_drafts` and `finalize_stock_count_verification_delivery` — so
the security result is consistent across the whole feature rather than stopping at
the cut-off functions.

Two entry points are easy to misclassify and are called out in `07`'s comments:
`verify_and_post_inventory_opening_cutoff` (selected via a route variable, so it is
never a literal `.rpc()` argument) and `archive_product_variant` (called through the
`ARCHIVE_PRODUCT_VARIANT_RPC` constant). Both retain `authenticated`.

Conversely `verify_and_post_inventory_opening_cutoff_scoped_legacy` and
`archive_stock_count_draft` are **internal** — reached only from inside another
SECURITY DEFINER function — and correctly end up with no client grant.

## 17. Is the pack rerunnable?

**Yes — this was tested, not assumed.**

Every file was executed **twice in a row** against a disposable database restored
from a real production schema dump. The second run completed with zero errors.

The properties that make this safe:

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`
- `CREATE OR REPLACE FUNCTION` for every function
- `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`
- `DROP POLICY IF EXISTS` + `CREATE POLICY`
- `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (both are widenings)
- `06`'s two `UPDATE`s match zero rows once already applied

**One deliberate departure from history:** the original migrations installed
`inventory_cutoff_preview` and `verify_and_post_inventory_opening_cutoff` by
renaming the live function to a `*_pre_<feature>` name and creating a new wrapper.
That pattern is *not* rerunnable — a second run would rename the wrong function and
corrupt the chain. This pack installs every layer under its final name with
`CREATE OR REPLACE` and replays no rename.

⚠️ The `*_pre_*` functions are **load-bearing**, not leftovers: `inventory_cutoff_preview`
is a thin wrapper on an eight-layer delegation stack. `04` installs all of them.
Removing them breaks preview at runtime. See `MIGRATION_AUDIT.md`.
