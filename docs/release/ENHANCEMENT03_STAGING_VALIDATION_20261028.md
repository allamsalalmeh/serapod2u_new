# Enhancement03 staging integration follow-up — 2026-10-28

Status: BLOCKED — MIGRATION HISTORY AMBIGUITY. No deployment authorized by passing gates yet.

## Finance correction

Starting integration commit: `47a32682d6f1033b4ad6850c37b724c315d6de2d`.
The staging finance route synchronization branch directly called setCurrentView followed by router.push.
That bypassed Enhancement03's openView guard, painting a destination view before the arriving route painted it again.
Use openView(financeViewId, `/${financeViewId}`), retaining staging's normalized finance URL and its subroutes.
The focused regression covers finance root, journals, bank accounts, same-path navigation, and the shared guard.
Verified: 8 test files / 41 tests passed (finance navigation, payment rules/callbacks, paid email, staff alert, refund and signature tests).
Log: `/tmp/enhancement03-finance-fix-tests.log`. No unrelated application changes made.

## Colliding versions: no safe filename mapping established

All five bodies have different SHA-256 hashes; these are distinct migrations, not duplicate copies.
No migration was renamed, removed, executed or changed. Mapping: existing filename -> unchanged filename for every row.

| Filename | SHA-256 |
|---|---|
| `20261030100000_sa_policy_org_type_eligibility.sql` | `92d303e45b952d308274799190a558c110aa693ec4691e16ad29539309bd833b` |
| `20261030100000_supply_chain_document_notifications.sql` | `233a263dc2bc5d250b080ff3968632e8eef8404b6c1a9bb19cea14affaaf3df5` |
| `20261216100000_identity_permanent_deletion.sql` | `22b065cf3f90b59361dc6b2867a227c2e1fc9a72d646c954f03967876011f1f2` |
| `20261216100000_sa_legacy_preview_scope_coverage.sql` | `339c2fb499b25ae65eca1891514a55293edbd65956a00a26ee508ca302350779` |
| `20261216100000_storefront_order_paid_notification_type.sql` | `a87cccd32faa9ef3294ce9d9431440996824a97c39f1d59366930ce88dc029e1` |

Evidence reviewed (saved metadata and repository history only; no SQL executed):

- `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`, row 44: organization eligibility recorded applied on staging 2026-10-13 and independently verified 2026-10-16. Preserve its filename.
- `docs/notifications/supply-chain-related-organization.md`, section 0.1: document notification SQL recorded applied on staging 2026-10-27. Section 0.3 pins SHA-256 233a263d...; it matches the current file exactly. Older unapplied statements in section 0.3 conflict with the later status; the document explicitly makes its reconciled section 0 authoritative.
- `tmp/notification-evidence/apply-20261027-2021/editor-results-2031.txt`: operator report of 8/8 document checks and 9/9 postchecks on 2026-10-27. This proves saved effect evidence, not a complete ledger of executed statement bytes: the document says SQL Editor committed statements one by one.
- `docs/hr/release/wave2-employment-foundation-2026-10-25/README.md`, section 4: identity permanent deletion and S&A legacy preview effects present on staging; explicit decision to keep both filenames. It records staging lacks `supabase_migrations.schema_migrations`.
- `app/src/lib/hr/migration-versions.test.ts`: records these previously known 20261216100000 files as a count of two, and explicitly prohibits renaming applied files.
- `git log origin/staging -- supabase/migrations/20261216100000_storefront_order_paid_notification_type.sql`: introduced by d7aeaff3, 2026-10-27. Its presence in deployed-branch history is not proof its INSERT was applied. No matching application record found in reviewed documentation or migration status register.

Exact unresolved history: application provenance of the third 20261216100000 staff-alert migration; no complete version ledger or authoritative cross-file filename reconciliation for these applied/partially evidenced collisions. Neither arbitrarily renaming an applied file nor increasing the test's allowed duplicate counts proves a safe reconciliation.

Required resolution: obtain an authoritative owner-confirmed application inventory (exact file/hash, environment, execution date/edition, existing ledger if any), especially for the staff-alert migration, and an explicit history-preserving duplicate-version policy/mapping. Do not run SQL as part of this task. Do not infer unapplied status from a missing Git record.

## Stopped phases

Per Phase 2's explicit STOP instruction, inventory/ship-metrics remediation, three-way TypeScript baseline comparison, fresh build/full-suite/CI validation, push, PR, merge and deployment were not performed in this follow-up. Earlier results remain historical failures, not current passes: 266 TypeScript errors, 5 full-suite failures, and isolated-build dependency-resolution failures.

All previous reconciliation is retained. The 36 staging-only commits and prepared Enhancement03 remain ancestors of the current integration history. Temporary local files are untouched. Production, main and database state were not modified.
