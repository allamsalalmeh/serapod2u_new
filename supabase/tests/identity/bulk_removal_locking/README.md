# Bulk removal — isolated lock regression test

Reproduces the Issue 1F failure mechanism with a disposable PostgreSQL cluster and synthetic UUIDs. It never touches the
project or staging database.

The canonical permanent deletion takes `LOCK TABLE … IN SHARE MODE` on the tables listed by
`identity_deletion_plan.lock_tables`. `hr_employees` is in that list because `onboarded_by` /
`onboarding_reset_by` have no foreign key, and `identity_lifecycle_actions` is included through
`actor_id` / `target_user_id`. The same transaction then deletes from `hr_employees`, which needs
`ROW EXCLUSIVE`. These scripts mirror that lock order, plus the archive path (UPDATE `hr_employees`,
INSERT `identity_lifecycle_actions`).

Run (requires `initdb`, `pg_ctl`, `psql` and `pg_isready` on PATH):

```bash
./run.sh
```

Expected:

```
PASS: two concurrent deletions deadlock (40P01) and exactly one transaction is rolled back
PASS: deletion beside an archive hits lock timeout (55P03); archive succeeds
PASS: overlapping requests for one identity: one acts, the other finds it gone (no duplicate record)
PASS: serialized deletions both succeed with no orphan rows
RESULT: PASS
```

The first two scenarios are the bug; the third is the fix (application executes destructive work serially). The scripts
are a lock-mechanism reproduction, not a full copy of the production schema.
