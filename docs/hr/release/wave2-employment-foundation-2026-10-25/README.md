# Wave 1 closure + Wave 2 (HR foundation & employee lifecycle) — release package (2026-10-25)

Back to [HR_MASTER_INDEX.md](../../HR_MASTER_INDEX.md) · Wave 1 package: [b2a-staging-2026-10-24](../b2a-staging-2026-10-24/README.md) · UAT: [HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md](../../uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md) · S&A handover: [HR_SA_DEPENDENCY_HANDOVER_WAVE2.md](HR_SA_DEPENDENCY_HANDOVER_WAVE2.md)

Prepared on `Enhancement03`, HEAD `b6b78002` (no commit, nothing pushed, nothing deployed). Coder AI did **not** connect to staging or production, did not change S&A grants, and did not perform UAT.

## 1. Status at a glance (separate fields — rule 14)

| Item | Design | Code | Tests (isolated) | Migration file | Staging applied | Production | App deployed | Owner UAT |
|---|---|---|---|---|---|---|---|---|
| B2A leave containment `20261219100000` | Yes (D-021…D-028) | Yes | PASS 172/172/195/195 (re-run 2026-10-25) | Yes | **Yes — owner-applied 2026-10-24; verified read-only 2026-10-25 (12/12 mandatory PASS)** | No | **No** (staging app = old build: no B2A/B2B markers) | Not run |
| B2B operational repairs (no migration) | Yes (D-029…D-031) | Yes | PASS (Vitest) | n/a | n/a | n/a | **No** | Not run |
| Wave 1 closure fixes 2026-10-25 (mobile half-day, mobile false success, MSS Approvals tab, verify script) | E-13…E-15 | Yes | PASS (Vitest, negative control) | n/a | n/a | n/a | No | Not run |
| Wave 2 `20261221100000_hr_employment_foundation` | E-16…E-24 (engineering, owner directive 2026-10-25) | Yes | PASS 235 (stg, default order) / 235 (`--w2-first`) / 192 (prod snapshot, no lifecycle files) / negative control 7 | Yes | **No (not authorized)** | No | No | Not run |
| Wave 2 app (routes, profile sheet, history, reporting-line check, B3 evaluators) | as above | Yes | PASS (Vitest) | n/a | n/a | n/a | No | Not run |

## 2. Evidence used (no live access by Coder AI)

* KVM2 read-only run by the owner, `~/serapod-hr-kvm2/out-20261025-001019/` (read from the Mac, files unchanged): host `mail`, `serapod-stg-db` PostgreSQL 17.6, read-only session; **M00–M11 PASS**; 9/9 functions with body md5 = repository; 4/4 triggers `O`; 6 B2A policies, 0 others; RLS/events sealed; reset scope keeps events; 1 expected optional error (`supabase_migrations.schema_migrations` absent — staging has no migration ledger).
* Same run, B0 v2 section A: effects of `20261214100000_hr_employee_controlled_delete`, both `20261216100000` files, `20261217100000`, `20261218100000`, `20261213100000_sa_organization_insert_gate`, `20261215110000` and `20261022100000_core_system_preferences` are **present on staging**.
* Same run, deployed-build markers: the B2A/B2B markers are in **none** of the application containers → the staging app does not yet run Wave 1 code (BL-21 stays open).

## 3. Approver coverage finding (do not mistake the 12 checks for this)

From `07_b2a_post_apply.txt` §F/§G (staging, 2026-10-25):

| Finding | Value | Consequence |
|---|---|---|
| `hr.leave.approve` holders via legacy compatibility | **13** | none of them can decide leave after B2A (by design, D-021) |
| … via explicit (non-legacy) policy | **0** | **nobody except Root can approve leave as HR on staging** |
| `hr-leave-attendance-administrator` / `hr-payroll-full-access` / `manager-self-service` active holders | **0 / 0 / 0** | no direct manager can approve leave either |
| Active Root Access grants | 2 | Root can decide (as `root`) |
| Pending leave requests on staging | 0 | no one is blocked **today** |
| Employees reporting to an inactive/archived manager (B0 v2 E) | **2** | will appear in the Wave 2 reporting-line check |
| Completed employees without a manager | 4 | appear as `NO_MANAGER` |

**Owner action (S&A, not HR code):** grant *Leave & Attendance Administrator* (HQ-scoped) to the real HR approvers and *Manager Self-Service* to real line managers — use `../b2a-staging-2026-10-24/hr_b2a_approver_coverage_readonly.sql` for the named worklist. For Wave 2, HR administrators additionally need *HR Records Officer* (`hr.employee.manage`/`view`, explicit): the Wave 2 entry points never accept legacy compatibility access.

## 4. Migration version collisions — decision (E-13)

| Version | Files | Applied evidence | Decision |
|---|---|---|---|
| `20261214100000` | `hr_employee_controlled_delete` (HR) · `outdoor_shop_warehouse_and_online_stock` (origin/main) | HR file effects **present on staging** (2026-10-25); origin/main file applied per PMS | **Keep both names** (D-017: never rename an applied file). Supersedes the 2026-10-24 "re-stamp before B1" note (BL-14) |
| `20261215100000` | `sa_payment_gateway_restriction` (S&A) · `return_items_source_unit_price` (origin/main) | S&A file: not measured; origin/main applied | **S&A-owned — handover** (not renamed by HR) |
| `20261216100000` | `identity_permanent_deletion` · `sa_legacy_preview_scope_coverage` | both effects present on staging | Keep |
| `20261022100000` | `core_system_preferences` (untracked) · applied file | effect present on staging | Keep |
| `20261212100000`, `20261213100000` | origin/main pairs | applied | Keep |
| `20261220100000` | `inventory_cases_and_pcs` (inventory workstream, created concurrently 2026-10-25 08:27 MYT) · Wave 2 HR file (first stamp) | neither applied | **HR file re-stamped to `20261221100000`** before any application (the only allowed fix: never-applied file) |

Staging has **no** `supabase_migrations.schema_migrations` ledger, so collisions affect only tooling (`supabase db push`/diff), not the hand-applied history (D-018). The regression test `app/src/lib/hr/migration-versions.test.ts` pins the current set; any **new** collision fails. Wave 2 uses the unique version `20261221100000` (after B2A and after the inventory file `20261220100000`).

## 5. Supported migration order

1. `20261003100000` … `20261218100000` (already on staging) → `20261219100000` B2A (on staging) → **`20261221100000` Wave 2**.
2. Also tested: Wave 2 **before** the lifecycle files and B2A (`run.sh --w2-first`) — passes; and B2A + Wave 2 on the 2026-10-16 production snapshot without the lifecycle files (`--no-lifecycle`).

## 6. Owner-run steps (staging only; each separately authorized)

| Step | Action | Pass criterion |
|---|---|---|
| W-1 | Mac: `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` (fixed 2026-10-25: cron/site variables are now set only for the build — before, Vitest showed 24 false failures) | Vitest: only `orders/[orderId]/ship-metrics` fails (non-HR); tsc 0 HR errors; build OK |
| W-2 | Review the diff; commit **only** the manifest below (§9) | commit hash |
| W-3 | Backup staging; `psql "<staging>" -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261221100000_hr_employment_foundation.sql`; record in `PRODUCTION_MIGRATION_STATUS.md` | applied without error (it refuses itself if overlapping active salaries exist) |
| W-4 | `PGOPTIONS='-c default_transaction_read_only=on' psql "<staging>" -X -v ON_ERROR_STOP=0 -f docs/hr/release/wave2-employment-foundation-2026-10-25/hr_w2_staging_post_apply_readonly.sql > w2_post_apply.txt` (or add it to the KVM2 script run) | §1 all present; §2 all `O`; §3 forced, no API privileges; §4 `employments_without_version = 0`; §5 six `keep`; §6 overlap 0; §9 B2A still 6 policies |
| W-5 | S&A grants of §3 (People & Access) | approvers listed with explicit policies |
| W-6 | Deploy the W-2 commit to staging (separately authorized) | build markers present |
| W-7 | Owner UAT ([guide](../../uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md)) | signed summary |

## 7. Rollback (safe — never restores insecure leave access, never deletes history)

* **Wave 2:** run the ROLLBACK block of the migration header (drops the guard/history/overlap triggers and the four write functions, drops `hr_emp_comp_dates_chk`; keeps every history table and row). Rehearsed on the replica (`40_safe_rollback.sql`), then re-applied (`50_after_reapply.sql`: numbering continues, no second baseline). The B2A guard is untouched by this rollback.
* **B2A:** only the SAFE rollback from its header (D-028) — never the full revert.
* **App:** revert the commit; with the Wave 2 migration rolled back, the Wave 2 screens show "not installed on this environment yet" (503), never false data.

## 8. What Wave 2 delivers (engineering decisions E-16…E-24 in the register)

* **Employment history (S-01.7):** `hr_employee_versions` append-only, effective-dated; baseline per employment effective from the hire date (earlier changes not reconstructed, labelled); one version per change of status, type, department, position, manager, dates, organization, onboarding — from every path (HR screens, user management projection, onboarding, archive). As-of lookup `hr_employee_as_of`.
* **Lifecycle guard:** former (archived) employees locked; rehire only after identity reactivation (end date cleared, history kept); ending employment stamps `end_date`; new managers must be active, non-archived, same company, no cycle (also in fresh HR onboarding); existing invalid lines are reported, not blocked.
* **Employment-end effects (part of B7b):** active salary, allowances, deductions and position assignments end at the employment end date (rows kept). Direct reports are **not** silently moved.
* **Reporting lines (B7a):** review (former/inactive/other-company manager, cycle, missing manager, divergence from the position hierarchy), single-line change and direct-report reassignment with reason, append-only log; leave approval (B2A) follows immediately (replica S8/S9, UAT RL-04).
* **Controlled effective-dated change:** `hr_employment_change` (today or earlier; not before hire; no ending employment as a field change; company-scoped references).
* **HR Profile sheet repaired + statutory capture (S-01.6, A4):** the sheet's table never existed (every save failed, BL-17). Personal data → `hr_employee_profiles`; statutory data (NRIC, passport, tax, EPF, SOCSO, EIS, gender, DOB, nationality, marital status, tax residency, work state) → `hr_employee_statutory_profiles` — one source; server-only; explicit HR; employee read-only for statutory; logs carry column names only.
* **Compensation integrity (A2):** no overlapping active salaries; end ≥ start; append-only change log with old/new values.
* **Finance-ready (A1/A3 slots, contract v1):** nullable `cost_center_ref` (Finance-owned), `payroll_component_code` slots, `hr_employment_finance_contract_v1` (no amounts, no statutory numbers). **No** payroll engine, PCB/EPF/SOCSO/EIS calculation, GL posting, account creation or payroll release.
* **B3 (HR-owned part):** 32 HR routes no longer pass an allow-everyone legacy evaluator (`() => true`); they use the default HR legacy rule in SHADOW modes; regression test `b3-legacy-evaluators.test.ts`. All new entry points require explicit (non-legacy) S&A authority in the employee's organization.

## 9. HR-only Git manifest (Wave 1 + Wave 2) — not staged, not committed

Verify first: `git status --short` and compare; stage **exactly** these paths (never `git add .`/`-A`); use `git add -p` for files that other workstreams may also have touched. `*.test.ts(x)`, `**/tests/**`, `*.sh` need `git add -f` (BL-16).

**Wave 1 (unchanged from the Wave 1 manifest, 61 files)** — see [Wave 1 README §Manifest](../b2a-staging-2026-10-24/README.md#hr-only-commit-manifest), plus the closure files now applied: `docs/hr/release/b2a-staging-2026-10-24/{README.md,kvm2_hr_wave1_readonly.sh,local_verify_isolated.sh,hr_b2a_staging_post_apply_readonly.sql}`.

**Wave 1 closure 2026-10-25 + Wave 2 (this package):**

```bash
# modified, tracked (review hunks)
git add -p -- app/src/components/hr/mobile/HrMobileLeave.tsx app/src/app/hr/mobile/layout.tsx \
  app/src/app/hr/pages.access.test.tsx app/src/components/hr/HrPeopleView.tsx \
  app/src/app/api/hr/employees/profile/route.ts 'app/src/app/api/users/[id]/hr/route.ts' \
  app/src/lib/security-access/route-coverage.ts app/src/lib/hr/schema-contract.test.ts app/src/lib/hr/migration-versions.test.ts
# B3: allow-everyone legacy evaluators removed (32 HR routes)
git add -p -- $(cat docs/hr/release/wave2-employment-foundation-2026-10-25/b3_route_files.txt)
# new files
git add -- supabase/migrations/20261221100000_hr_employment_foundation.sql \
  app/src/modules/hr/leave/mobileLeave.ts app/src/lib/hr/employment-messages.ts app/src/lib/hr/employment-foundation.ts \
  'app/src/app/api/hr/employees/[id]/history/route.ts' 'app/src/app/api/hr/employees/[id]/employment/route.ts' \
  app/src/app/api/hr/reporting-lines/route.ts \
  app/src/components/hr/people/EmploymentHistoryPanel.tsx app/src/components/hr/people/ReportingLinesReviewDialog.tsx \
  docs/hr/uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md docs/hr/release/wave2-employment-foundation-2026-10-25/
git add -f -- app/src/modules/hr/leave/mobileLeave.test.ts app/src/components/hr/mobile/HrMobileLeave.test.tsx \
  app/src/lib/hr/employment-messages.test.ts app/src/lib/hr/b3-legacy-evaluators.test.ts app/src/lib/hr/test-support/wave2Mocks.ts \
  'app/src/app/api/hr/employees/[id]/history/route.test.ts' 'app/src/app/api/hr/employees/[id]/employment/route.test.ts' \
  app/src/app/api/hr/reporting-lines/route.test.ts app/src/app/api/hr/employees/profile/route.wave2.test.ts \
  app/src/components/hr/people/Wave2Panels.test.tsx supabase/tests/security/hr_employment_foundation/
# master documents
git add -- docs/hr/HR_MASTER_INDEX.md docs/hr/HR_MASTER_SCOPE.md docs/hr/HR_DECISION_REGISTER.md \
  docs/hr/HR_IMPLEMENTATION_ROADMAP.md docs/hr/HR_PROGRESS_TRACKER.md docs/hr/HR_GO_LIVE_GATES.md
```

**Never stage (not HR / not deliverables):** `a3.out`, `d5.out`, `h1.out`, `h2.out`, `backup_diag.txt`, `*.code-workspace`, `components/dashboard/DashboardContent.tsx`, `app/src/lib/navigation/`, `app/src/components/inventory/*`, `app/src/lib/inventory/*` (other workstreams), `docs/hr/hr-closure.zip` (delivery archive, already applied), `tmp/`.

`lib/security-access/route-coverage.ts` is an S&A file: the change only **registers** the three new HR routes (classification, no authorization change) — included here, flagged in the S&A handover.

## 10. Exact application revision evidence

* Source: `Enhancement03` @ `b6b78002` + the uncommitted manifest above. No build artefact was produced for deployment.
* Staging application containers (2026-10-25): `ao0gw084g0skgoo0ko4wwsco` image tag `0726ce46…`, others older — none contains Wave 1/2 markers. After W-6 the KVM2 script's build-marker section must show the markers.
