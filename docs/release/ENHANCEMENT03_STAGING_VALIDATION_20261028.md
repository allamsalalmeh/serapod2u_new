# Enhancement03 staging integration follow-up — 2026-10-28

Status: LOCAL VALIDATION COMPLETE — pending PR CI and verified staging deployment. The follow-up below supersedes the earlier migration-history blocker.

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


## Code-only release verification follow-up

User clarified that EH records are manually maintained Supabase Studio saved queries for future production cutover; missing execution-ledger provenance is not a code-only staging blocker. No SQL or RPC with write effects was executed in this assessment. No migration contents or filenames changed.

### EH01–EH23 discovery

Read through SSH on the positively verified KVM2 host `mail`, from the staging Studio snippets volume `/var/lib/docker/volumes/serapod-stg-snippets-data/_data`. EH1–EH22 are saved as `EH<n>.sql`; EH23 is `Eh23-Tukar ke Prod then run dekat terminal.sql` (terminal instructions, never executed). Saved text does not itself prove execution. EH4/EH8/EH11 and EH9/EH12 are byte-identical repetitions, not separate required migrations. EH17–EH19 are read-only inventory diagnostic/readiness variants. EH1 explicitly says production-only, not applied, staging already has the correct permission spelling. EH23 references document SQL postchecks and catalog-copy SQL. Wave 3 attendance's separate repository script is not explicitly named by these EH labels; all changed-code RPCs are nevertheless present in live staging metadata.

| EH | Repository mapping / references | Match | SHA-256 prefix |
|---|---|---|---|
| EH1 | `Inline production-only MSS permission spelling correction (staging already correct)` | reference / saved variant | `3653094cea73` |
| EH2 | `supabase/migrations/20261212100000_distributor_analytics_active_orders.sql` | byte-identical | `473f622fde0b` |
| EH3 | `supabase/migrations/20261213100000_sa_organization_insert_gate.sql` | byte-identical | `fc86be531c83` |
| EH4 | `supabase/migrations/20261214100000_hr_employee_controlled_delete.sql` | byte-identical | `23fbee6377f6` |
| EH5 | `supabase/migrations/20261215100000_sa_payment_gateway_restriction.sql` | byte-identical | `69e45d5a9b75` |
| EH6 | `supabase/migrations/20261215110000_sa_legacy_compat_cutover_controls.sql` | byte-identical | `83c9af8ac37c` |
| EH7 | `supabase/migrations/20261215120000_sa_hr_employee_delete_mode_retired.sql` | byte-identical | `9976e14ba8c1` |
| EH8 | `supabase/migrations/20261214100000_hr_employee_controlled_delete.sql` | byte-identical | `23fbee6377f6` |
| EH9 | `supabase/migrations/20261216100000_identity_permanent_deletion.sql` | byte-identical | `22b065cf3f90` |
| EH10 | `supabase/migrations/20261216100000_sa_legacy_preview_scope_coverage.sql` | byte-identical | `339c2fb499b2` |
| EH11 | `supabase/migrations/20261214100000_hr_employee_controlled_delete.sql` | byte-identical | `23fbee6377f6` |
| EH12 | `supabase/migrations/20261216100000_identity_permanent_deletion.sql` | byte-identical | `22b065cf3f90` |
| EH13 | `supabase/migrations/20261217100000_identity_archive_identifier_release.sql` | byte-identical | `b323dd9847ee` |
| EH14 | `supabase/migrations/20261218100000_identity_archive_optional_reason.sql` | byte-identical | `a60f0d1c9418` |
| EH15 | `supabase/migrations/20261219100000_hr_leave_containment_guard.sql` | byte-identical | `caace5b1f35b` |
| EH16 | `supabase/migrations/20261221100000_hr_employment_foundation.sql` | byte-identical | `5e8cba8b4518` |
| EH17 | `20261220100000_inventory_cases_and_pcs.sql` | reference / saved variant | `88b74b915c69` |
| EH18 | `20261025_inventory_cases_pcs_readiness_sql_editor.sql`; `supabase/migrations/20261220100000_inventory_cases_and_pcs.sql` | reference / saved variant | `1e099a5167f9` |
| EH19 | `20261025_inventory_cases_pcs_readiness_sql_editor.sql`; `20261025_sql_editor_canary.sql`; `supabase/migrations/20261220100000_inventory_cases_and_pcs.sql` | reference / saved variant | `775b20ebd282` |
| EH20 | `supabase/migrations/20261223100000_hr_leave_ledger.sql` | byte-identical | `37b3adb46afc` |
| EH21 | `Inline Inventory cases + loose-pieces migration; saved variant` | reference / saved variant | `1aacb3330472` |
| EH22 | `supabase/migrations/20261224100000_hr_w3_wp_holiday_alias.sql` | byte-identical | `8bb9767fea02` |
| EH23 | `supabase/diagnostics/20261027_document_sql_editor_run_verify_readonly.sql`; `supabase/diagnostics/20261030_notification_sql_postcheck_readonly.sql`; `supabase/migrations/20261027160000_notification_types_order_copy.sql` | reference / saved variant | `8e36cb4afe32` |

Evidence: metadata API GET verified **105/105** unique functions declared by these saved records exist in public, including internal trigger helpers not exposed as RPCs. PostgREST OpenAPI GET verified **57/57** literal RPC names in changed application files. These checks prove present objects, not full body equivalence or historical execution order. Previously saved HR and notification application/postcheck evidence remains in the earlier section. Exact production execution order, duplicate records and script editions remain production cutover reconciliation work.

### Staff notification compatibility

Read-only staging REST GET verified one `notification_types` row: `storefront_order_paid`, category `ecommerce`, `default_enabled=false`, channels `sms,whatsapp`. Empty-result schema-contract GETs succeeded for storefront orders with embedded items, settings with recipient configuration, provider configuration, outbox `payload_json`, and the stock movement display view. Live metadata confirms `queue_notification` exists. No queue RPC was invoked, no setting changed, and no message was sent. Delivery still depends on UAT configuration/providers and enabling the event deliberately.

### Deployment configuration

Read-only Coolify model inspection on KVM2 confirms application `ao0gw084g0skgoo0ko4wwsco`, repository `edierwan/serapod2u_new`, branch `staging`, commit selector HEAD, Dockerfile build, base directory `/app`, Dockerfile `/Dockerfile`, auto-deploy enabled, pre/post deployment commands null, health check `/api/health`, running healthy. Existing deployed image and finished deployment both identify staging commit `66d497223299711f0555dbec83880f563282ec62`. Keep that commit/image as rollback reference; no rollback was performed. CI runs npm ci + build; Dockerfile runs npm ci + build and starts node server.js. None executes migrations. No deployment configuration changed.

### Validation fixes

- Retained finance route synchronization through the destination-render guard (commit 3d01f37d).
- Inventory refresh assertion now follows the unified versioned loader, which reads incoming alongside balances; no application refresh behaviour changed. Existing component tests cover refresh retention, races and failed incoming reads.
- Schema fixture parser now recognizes pg_dump `CREATE VIEW ... WITH (...) AS`, retaining column checks. The view exists in the original snapshot and in live staging; no database view changed. Added positive/negative parser unit coverage.
- Recorded the exact duplicate version counts 20261030100000 x2 and 20261216100000 x3 in the existing historical collision test. Negative controls still fail any new collision. This acknowledges code-only release history, not migration reconciliation or permission to execute these files.

### Results

- Full final Vitest: **714 files passed; 6,987 tests passed; 6 skipped**. Finance, payment/email, inventory and ship-metrics included. Log `/tmp/enhancement03-release-final-tests.log`.
- Focused inventory/ship-metrics checks: **36 tests passed**; parser unit tests: **2 passed**.
- Clean lockfile install (`npm ci --include=dev`) and `npm run build`: **exit 0** on Node 22.21.1, isolated copy with dead loopback Supabase URLs and disabled cron workers; never deploy this local verification output. Earlier copied-dependency build failure was an environment artifact. Log `/tmp/enhancement03-clean-build.log`.
- Identical clean TypeScript checks (same lockfile deps, same tsconfig, same generated next-env declarations, no stale .next validators): source **250**, staging **255**, integration **250** diagnostics, all exit 2. Entire normalized diagnostic blocks AND multiplicities on integration match prepared Enhancement03 exactly; **0 integration-introduced diagnostics**. The earlier 266 included 16 generated .next validator errors. No unrelated type refactoring performed. Logs `/tmp/enhancement03-{source,staging,integration}-clean-tsc.log`.
- No lint script/config in repository tooling. Historical TypeScript failure remains a warning, not a pass; build intentionally ignores types per existing repository configuration.
- PR CI and final deployed commit/health still require verification after push/merge.
