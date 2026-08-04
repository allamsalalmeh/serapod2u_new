# Rollback and recovery

Honest summary first: **this pack has no automatic rollback.** Four of the seven
executable files can be reverted cleanly only while their own transaction is still
open. Once a file has committed, "undo" means either a compensating change you write
yourself or a restore from backup. Plan accordingly.

---

## 1. Transactional rollback — reliable, but only during execution

Files `02`, `03`, `04`, `05`, `06` and `07` are each wrapped in a single
`BEGIN … COMMIT`.

If a statement fails, PostgreSQL aborts the whole transaction and **nothing from
that file is applied**. The database is exactly as it was before the file started.

This covers the common cases: a typo, a missing prerequisite, a permission problem,
a constraint violation, `ON_ERROR_STOP=1` firing.

✅ **Safe action:** fix the cause, then re-run the same file.

**This guarantee does not hold if:**

- the psql client was killed (Ctrl-C at the wrong moment, closed terminal, dropped SSH),
- the server restarted or was OOM-killed mid-file,
- someone ran the file with `ON_ERROR_STOP` unset — psql then continues past errors
  and **commits whatever succeeded**. Always pass `-v ON_ERROR_STOP=1`.

In any of those cases, treat the state as **unknown** and go to §2.

---

## 2. Recovery after a partially completed file

**Do not re-run the file blindly.** Establish the real state first:

```bash
psql "$URL" -f 01_preflight_read_only.sql          # what exists now
psql "$URL" -f 08_post_deployment_verification.sql # what is missing vs the contract
```

Both are read-only and safe at any time.

Then, by file:

| File | If it half-applied | Action |
|---|---|---|
| `02` | Some tables created | Re-run. `CREATE TABLE IF NOT EXISTS` skips the rest. **Safe.** |
| `03` | Constraint dropped but not re-added | ⚠ See §2.1 — a window exists where `stock_movements` has **no** reference_type CHECK. |
| `04` | Some functions replaced | Re-run. `CREATE OR REPLACE` is idempotent. **Safe.** |
| `05` | Some policies created | Re-run. `DROP POLICY IF EXISTS` + `CREATE POLICY`. **Safe.** |
| `06` | One UPDATE applied, not the other | Re-run. Both are idempotent; the second run matches 0 rows. **Safe.** |
| `07` | Some functions replaced | Re-run. **Safe.** |

### 2.1 The one genuinely dangerous window — file `03`

`03` runs, in order:

```sql
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reference_type_check;
ALTER TABLE public.stock_movements ADD  CONSTRAINT stock_movements_reference_type_check CHECK (...);
```

Inside the transaction this is atomic and invisible to other sessions. **But** if the
transaction is destroyed abnormally between the two statements *and* the abort does
not complete (server crash, storage failure), you could be left with the constraint
dropped and not re-added.

**Check for it:**

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'stock_movements_reference_type_check';
```

Zero rows = the constraint is missing. Re-run `03`; it re-adds it. Until then,
`stock_movements` accepts any `reference_type` value, so **do not let the
application write movements in that window.**

---

## 3. Schema recovery

There is no generated "down" script, deliberately. A `DROP` script for this pack
would be more dangerous than the pack itself.

### What can be reversed by hand

**New tables (`02`).** If they are empty and you are certain no cut-off used them:

```sql
-- DESTRUCTIVE. Verify emptiness first.
SELECT 'd2h_policies', count(*) FROM public.inventory_cutoff_d2h_policies
UNION ALL SELECT 'h2m_policies', count(*) FROM public.inventory_cutoff_h2m_policies
UNION ALL SELECT 'transactions_policies', count(*) FROM public.inventory_cutoff_transactions_policies
UNION ALL SELECT 'excluded_transactions', count(*) FROM public.inventory_cutoff_excluded_transactions
UNION ALL SELECT 'allocation_requests', count(*) FROM public.inventory_cutoff_allocation_requests
UNION ALL SELECT 'h2m_bulk_requests', count(*) FROM public.inventory_cutoff_h2m_bulk_requests;
```

Only if **every count is 0**, dropping them returns you to the prior schema. If any
count is non-zero, those rows are audit and idempotency records for real operator
decisions — **dropping them destroys audit history.** Restore from backup instead.

**Widened CHECK constraints (`03`).** Narrowing them again will **fail** if any row
now uses a new value — which is exactly what you want. Never use `NOT VALID` to force
a narrower constraint over non-conforming rows.

### Grant hardening (`07`) — fully reversible

`07` removes client EXECUTE across the Stock Count V2 / Opening Balance surface and
hands it back to `authenticated` + `service_role` for application entry points only.

To restore the previous (Supabase platform default) state exactly — run as
`supabase_admin`:

```sql
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
```

Narrower, to restore a single function:

```sql
GRANT EXECUTE ON FUNCTION public.inventory_cutoff_preview(uuid) TO anon;
```

No data is involved and nothing is lost, so this needs no backup.

**Symptom if an entry point was wrongly revoked:** the UI gets
`permission denied for function ...` (PostgREST surfaces it as a 4xx). Re-grant that
one function to `authenticated, service_role` and add it to `v_entry_points` in `07`
so the fix survives a re-run.

### What cannot be reversed by hand

**Function definitions (`04`, `07`).** `CREATE OR REPLACE` overwrites the previous
body with no history. Once committed, the old definition exists **only in your
backup** and in the original migration files under `supabase/migrations/`. There is
no `pg_get_functiondef()` for a version you have already replaced.

If you must revert one function, extract its previous body from the corresponding
historical migration and re-apply that. Consult `MIGRATION_AUDIT.md` for which file
held which version — and be aware that reverting a single layer of the preview
delegation chain will desynchronise it from the layers above.

---

## 4. Data recovery

Only `06_PhaseB_reconciliation_apply.sql` and `00_PhaseB_cancel_counting_cutoff.sql` change data.

Both changes are **status flips on existing rows**. No row is deleted, no quantity
altered, no movement created.

| Change | Reverse |
|---|---|
| configs `active`/`phase_out` → `inactive` | The original value is **not recorded**. Reversal requires the backup. |
| sessions `draft` → `archived` | Same — the pre-update status is not preserved. |

Because neither change is self-describing after the fact, **run the preview block at
the top of `06` and keep its output.** If you also save the affected ids first, you
have a manual reversal path:

```sql
-- Optional: capture ids BEFORE running 06, keep the output somewhere durable.
SELECT isc.id FROM public.inventory_stock_configurations isc
JOIN public.product_variants pv ON pv.id = isc.variant_id
WHERE pv.is_active = false AND isc.status IN ('active','phase_out');

SELECT s.id FROM public.stock_count_sessions s
WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
  AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
              WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled');
```

Without that capture, restoring the backup is the only reliable reversal.

---

## 5. Restoring from backup — when it is the only reliable option

**Restore the backup, do not improvise, if:**

- a file committed and you need the *previous function definitions* back;
- `06` was applied and you need the original `status` values back;
- the deployment was interrupted abnormally and `01`/`08` show a state you cannot explain;
- any business data looks wrong after deployment — inventory quantities, allocations,
  movements or Opening Balance records;
- you are on **production** and anything at all is unexpected.

Do not attempt to "patch forward" on production to avoid a restore. A half-corrected
inventory contract is far worse than an outage.

### Restore procedure sketch

1. Stop the application (or put it in maintenance mode) so nothing writes during the restore.
2. Restore the verified pre-deployment backup.
3. Run `01_preflight_read_only.sql` and confirm the state matches your pre-deployment record.
4. Restart PostgREST/Kong so the schema cache matches the restored database.
5. Only then decide whether to retry the deployment.

**Anything written by users between deployment and restore is lost.** That is the
cost of the restore path and the reason §8 of the README makes the backup mandatory.

---

## 6. Lock-sensitive steps

**Measured read-only on production, 2026-08-04:** `stock_movements` holds
**2,945 rows / 864 kB** (2,256 kB with indexes) and **0 rows violate** the new
CHECK. `stock_count_session_items` holds **416 rows** with **0 duplicate** groups.
At this size every lock below is held for **milliseconds**. An earlier draft of this
document over-warned about a maintenance window; these measurements supersede it.

| Step | Lock | Impact |
|---|---|---|
| `03` — `ALTER TABLE stock_movements ADD CONSTRAINT` | `ACCESS EXCLUSIVE` on `stock_movements` | Blocks reads and writes while all rows are re-validated. At 2,945 rows: **milliseconds**. No maintenance window required. |
| `03` — `CREATE UNIQUE INDEX` on `stock_count_session_items` | `SHARE` | Blocks writes to that one table. Usually brief. Not `CONCURRENTLY`, because it must be inside the transaction. |
| `04`, `07` — `CREATE OR REPLACE FUNCTION` | `ACCESS EXCLUSIVE` on the function | Brief. Waits for any in-flight call to finish. |
| `02`, `05` | short-lived | Negligible. |

**Why not `NOT VALID` + `VALIDATE CONSTRAINT`?** That pattern reduces the blocking
window on large tables (`NOT VALID` takes a brief `ACCESS EXCLUSIVE` with no scan;
`VALIDATE` then scans under `SHARE UPDATE EXCLUSIVE`, allowing reads and writes). It
is deliberately **not** used here: it buys nothing on a 864 kB table, and it
introduces a real hazard — if `VALIDATE` is skipped or fails, the constraint stays
`NOT VALID` and silently tolerates pre-existing bad rows, which is a **weaker final
contract** than `9a62556a` requires. Revisit only if `stock_movements` grows beyond
roughly 10M rows, and then only as an explicit two-step with a
`convalidated = true` check afterwards.

---

## 7. What this pack will never do

- It never drops a business table.
- It never deletes a row.
- It never resets inventory, orders, stock movements or Opening Balance records.
- It never duplicates a movement or backfills the same business transaction twice.
- It never narrows a CHECK constraint.
