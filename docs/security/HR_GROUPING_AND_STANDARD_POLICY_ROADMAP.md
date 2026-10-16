# HR permission grouping + next Standard Policy roadmap

Status 2026-10-13, branch `issues-fixing-oct2`, folder `serapod2u_dev` (GitHub remote `serapod2u_new`).

* Phase 1 (HR grouping) is implemented and committed in `7eafa60a`.
* Phase 2 (assessment) was re-verified against staging (read-only) on 2026-10-13; see the corrections below.
* Phase 3: recommendations #1–#5 were approved by the business owner on 2026-10-13 and are implemented in
  migration `20261110100000_sa_policy_hardening_and_new_standard_policies.sql` (**not applied**) plus app wiring. See
  **Report C**.

## Evidence base and limits

| Source | Used for |
|---|---|
| `supabase/migrations/*.sql` (seeds, eligibility, coverage, SoD) | Policy → permission mapping, org-type eligibility, SoD rules |
| `app/src/lib/security-access/coverage-audit.ts` `seededProfilePermissions()` / `coverageReport()` (run locally) | Machine-extracted matrix and the 132-key permission universe |
| TS lock-step mirrors (`commission.ts`, `mss.ts`, `compensation-viewer.ts`, `stage2d-catalog.ts`, `group-policies.ts`) | Policies whose seed shape the parser misses |
| `docs/security/*.md` (Supply Chain coverage, Order View, Org-type eligibility, Warehouse Manager, ESS/MSS) | Earlier read-only staging facts and known enforcement gaps |

**Staging verified (read-only, 2026-10-13)** with the B.9 queries:

* 56 standard policies and 134 permissions. All 37 HR permissions are active.
* `hr.data.reset` is **`LEGACY_RETIRED`**, and so are `finance.data.reset`, `platform.data.destructive` and
  `platform.identity.delete`.
* Holders:
  * Finance Full Access: 1;
  * Platform & Settings Full Access: 1;
  * HR & Payroll Full Access: 0;
  * Security & Access Full Access: 2;
  * Supply Chain Full Access: 1.
* `reporting.analytics.view` is the **only** active permission in no standard policy.
* No same-document payroll/payment SoD violation has ever been recorded. There are 0 mitigations and 0 payroll runs.

Corrections to the repo-only assessment:

* **F3 withdrawn.** `finance-statement-preparer` / `finance-statement-approver` (with `finance.statement.import` /
  `.approve` and an enforced `bank-statement-maker-checker`) exist on staging. They come from
  `feature/bank-statement-approval`, which is merged into `staging` but **not into `issues-fixing-oct2`**. Merge `staging`
  into this branch before it is promoted.
* **F6 withdrawn.** On staging, Warehouse Operator holds `stock_count.create` without `.verify` (it holds
  `transfer.dispatch` instead).

New findings:

* **F11.** Compatibility roles `legacy-sa` (3), `legacy-hq` (15) and `legacy-power-user` (9) hold `finance.data.reset`
  through its compatibility rule (role level ≤ 20). Compatibility roles are real S&A assignments, so 27 accounts can reset
  accounting data in the new model, subject to its environment gate. `legacy-sa` (3) also holds
  `platform.data.destructive`. Not changed here: tightening the compatibility rule revokes access and needs its own
  decision.
* **F12.** Finance Full Access does not cover `finance.statement.import` / `.approve`. This is drift from the
  bank-statement branch; `sa_standard_policy_drift()` will list it.
* **F13.** Finance Admin holds both `finance.statement.import` and `.approve`. That is acceptable, because the
  same-document rule enforces, but it is worth a review.

---

# Report A — HR & Payroll grouping (implemented)

## A.1 Architecture finding

The grouping is **not stored in the database.** `sa_permissions` has `module`, `resource` and `action`, plus the CHECKs
`permission_key ~ '^seg.seg.seg$'` and `permission_key = module||'.'||resource||'.'||action`. It has no group, area or
submodule column, and no enum.

Every S&A screen gets its functional areas from **one** code taxonomy: `MODULE_TAXONOMY` in
`app/src/lib/security-access/modules.ts`, matched on `module.resource` of the key. The screens and their entry points:

| Screen | Entry point |
|---|---|
| Permission Catalogue / Migration Modes / Overview | `rollout.ts` `buildRollout` |
| Standard and Custom Policy editor and details | `profiles.ts` `buildPermissionPicker`, `AccessProfilesPanel` → `groupByTaxonomy` |
| Grant picker | `GroupPolicyPicker` → `groupByTaxonomy` |
| Roles & Policies | `permissionModuleLabel` |

The correct change is therefore **code-only, with no migration.**

* Nothing touches `sa_permissions`, so the `sa_permissions_permission_key_check` failure cannot recur.
* No key, id, grant, policy mapping or audit row changes.

## A.2 Change

`modules.ts`, HR & Payroll areas, in display order:

| # | Area (id) | Resources matched |
|---|---|---|
| 1 | Payroll & Compensation (`payroll`) | payroll, compensation, benefits, **commission** |
| 2 | Employees & Contracts (`employees`) | employee, contract, onboarding, recruitment |
| 3 | Time, Leave & Expenses (`time_leave`) | attendance, leave, leave_request, expense |
| 4 | Performance & Learning (`performance`) | performance, learning |
| 5 | Employee Self-Service (`self_service`) | self_service |
| 6 | **Manager Self-Service (`manager_self_service`)** — new | **mss** |
| 7 | HR Administration (`hr_admin`) | module, settings, policy, analytics, ai, **data** |

## A.3 Before → after (only the 10 moved keys; the other 27 HR keys are unchanged)

| Permission | Before | After |
|---|---|---|
| hr.commission.view / .manage / .approve | HR & Payroll · *General* (ungrouped) | Payroll & Compensation |
| hr.mss.team_view / attendance_view / leave_view / leave_approve / requests_view / performance_view | HR & Payroll · *General* | Manager Self-Service |
| hr.data.reset | HR & Payroll · *General* | HR Administration |

`reporting.commission.*` stays in Reporting, which is intentional because it is shared analytics. There are no HR exceptions
left: all 37 seeded `hr.*` keys land in one of the seven areas.

## A.4 Authorization safety

* The evaluator, RLS, `sa_require_operation`, grant coverage (`grant-coverage.ts`, groupId level), Full Access policy
  membership (`group-policies.ts`, groupId level) and recipient eligibility never read HR **areas**.
* Migration mode is stored per permission in `sa_migration_modes`. Retired stays retired, because moving a key to another area
  never changes its mode.
* One behavioural note: Migration Modes **area-level bulk moves** resolve their key set from the taxonomy (`bulk-modes.ts`
  `resolveGroup`).
  * A bulk move of "HR & Payroll · Payroll & Compensation" now includes the 3 commission keys.
  * A bulk move of "HR Administration" now includes `hr.data.reset`.
  * This is an explicit, previewed administrator action, and `LEGACY_RETIRED` keys are kept retired by the keep-retired
    rule (20261019110000).
  * A whole-module "HR & Payroll" bulk move already included all of these keys before the change.

## A.5 Tests

New: `app/src/lib/security-access/hr-grouping.test.ts` (9 tests). It scans **every migration** for seeded `hr.*`
permissions, so a future HR key that lands in "General" fails CI. It covers:

* the seven groups, in order;
* commission → Payroll & Compensation;
* the 6 MSS keys, together and alone, in Manager Self-Service;
* reset → HR Administration;
* no ungrouped HR keys;
* no reclassification of the other 27 keys;
* keys and modes preserved, including a `LEGACY_RETIRED` `hr.data.reset` staying retired in the Overview tree;
* identical areas and keys in the catalogue (`groupByTaxonomy`), the policy editor (`buildPermissionPicker`) and the Overview
  (`aggregateRollout`).

Results:

* `vitest run src/lib/security-access src/components/security-access src/components/users`: 894 passed, 4 failed.
  * The 4 failures are pre-existing and unrelated: `ui-contract` (top-level sections), `emergency-access-readiness` ×2 and
    `UserDialogNew.addUser`.
  * They fail identically with this change reverted, and they are the same four the eligibility work recorded.
* `tsc --noEmit`: 0 errors in the changed files. The repository has 423 pre-existing errors elsewhere.
* Lint: there is no `lint` script, and ESLint has no flat config in this repo, so it was not run.

No SQL to execute.

---

# Report B — Standard Policy roadmap (assessment only)

## B.1 Standard Policy inventory (repo-seeded, `source = 'template'`)

The 132 registered permissions are all classified, with no orphans. Partner eligibility comes from 20261030100000, which is
unapplied.

| Module | Policy (role_key) | Keys | Org types | Notes |
|---|---|---|---|---|
| Supply Chain | supply-chain-full-access | 32 | HQ | all SC keys incl. cancel/adjust/administer |
| | warehouse-manager | 19 (after 20261109, unapplied) | HQ, WH | inventory + product + returns, no orders/QR |
| | warehouse-operator | 6 | HQ, WH | count create+verify, transfer request/receive/view |
| | order-creator | order.create, order.view | HQ, DIST, SHOP | only partner-eligible SC policy |
| | order-approver | order.approve, order.view | HQ | DIST approval pending decision |
| | inventory-viewer | inventory.stock.view | HQ/DIST/WH (per 20261031) | |
| | catalog-viewer | product.catalog.view | HQ | DIST/SHOP backfill grants exist |
| | qr-batch-operator | qr.batch.manage | HQ (MFG declared, blocked) | |
| | adjustment-administrator | manufacturing.adjustment.administer | HQ | |
| | manufacturing-full-access-manufacturer | manufacturing.{production,adjustment,scan} | MFG | |
| | manufacturing-production-operator / -adjustment-handler / -scan-reversal | 1 each | MFG | **drafts, not assignable** |
| HR & Payroll | hr-payroll-full-access | 26 | HQ | incl. prepare+approve+release, data.reset |
| | hr-manager | 16 | HQ | admin incl. settings/policy; no payroll/compensation |
| | payroll-officer | 5 | HQ | prepare + compensation.manage |
| | payroll-approver | 4 | HQ | approve + compensation.view |
| | payroll-finance-approver | finance.module.view, hr.payroll.view, hr.payroll.release | HQ | no hr.module.view |
| | manager-self-service | 6 × hr.mss.* | HQ | |
| | manager-compensation-viewer | compensation.salary_view, allowance_view | HQ | |
| | commission-administrator / commission-approver / commission-report-viewer | manage+view / approve+view / reporting.commission.* | HQ | maker/checker split is correct |
| | employee-self-service | hr.self_service.use | HQ | lifecycle baseline |
| | hr-internal-directory-viewer | hr.employee.view_internal | HQ | partner backfill rows exist |
| | hr-data-reset-administrator | hr.data.reset | HQ | explicit grant + Super Admin |
| Finance | finance-full-access | 13 | HQ | incl. payment.approve + data.reset |
| | finance-admin | 11 | HQ | full minus payment.approve, data.reset |
| | finance-gl-clerk / finance-ar-clerk / finance-ap-clerk / finance-viewer / payment-approver | 4 / 3 / 3 / 6 / 3 | HQ | AR/AP clerks are **view-only** |
| | finance-statement-preparer / finance-statement-approver | ? | HQ | **named in 20261030 only; no seed in any migration** |
| Customer & Growth | customer-growth-full-access | 23 | HQ | |
| | roadtour-manager (4), loyalty-administrator (4), ecommerce-administrator (2), outdoor-store-operator, customer-messaging-manager, customer-report-viewer, support-inbox-administrator, storefront-banner-manager, crm-viewer, marketing-viewer, ecommerce-viewer | 1–4 | HQ | partner backfill rows exist (MFG/SHOP/WH) |
| Security & Access | security-access-full-access (12), security-administrator (12), access-reviewer (3) | | HQ | |
| Platform | platform-settings-full-access (11), identity-administrator (3), user-password-administrator, profile-administrator, system-log-viewer, notification-monitor-viewer | | HQ | |

## B.2 Coverage assessment (permissions with no narrow Standard Policy)

Narrow = not a Full Access policy.

| Permission(s) | Only in | Business function left without a policy |
|---|---|---|
| warehouse.receipt.post, warehouse.shipment.manage | SC Full Access | Warehouse receiving / dispatch |
| supply_chain.document.manage, .document.acknowledge, .order.cancel | SC Full Access | Order document processing, payment requester |
| inventory.return.request / .return.manage | SC Full Access, Warehouse Manager | Returns handling (HQ customer-service side) |
| product.catalog.manage | SC Full Access, Warehouse Manager | Product master-data management |
| hr.employee.manage, recruitment, onboarding, contract.* | HR Manager, HR Full Access | Recruitment & employee records officer |
| hr.attendance.manage, hr.leave.approve, hr.expense.manage | HR Manager, HR Full Access | Leave & attendance administrator |
| hr.benefits.manage, hr.compensation.manage (without payroll) | Payroll Officer, HR Full Access | Compensation & benefits manager |
| hr.ai.use | HR Full Access only | (gates the whole module assistant; legacy `() => true`) |
| customer.shop.manage, customer.campaign.manage, customer.loyalty.adjust, ecommerce.channel.manage | C&G Full Access | Sales/distributor relationship, marketing campaigns |
| reporting.analytics.view | **no policy at all** | Reporting / BI viewer |
| finance.data.reset, platform.data.destructive, platform.identity.delete | Full Access only | (correct that there is no narrow policy; see B.3-F2) |

Keys that the business areas ask for but **do not exist**:

* quality control;
* events;
* sales pipeline / quotations;
* AP/AR create/post (invoice entry, receipt posting);
* payment request create;
* HR position management (hr01–hr05 seed no `hr.position.*` key);
* a read-only HR viewer for payroll/compensation, distinct from operate.

## B.3 Findings — fix before adding policies

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **Full Access policies break their own SoD rules by design.** HR Full Access holds prepare+approve+release. Finance Full Access holds payment.approve with ledger posting. The payroll and payment SoD rules are `monitor`, so the conflict is silent. | 20260928100000 SoD seeds; 20261009100000 lists | High |
| F2 | **Destructive production operations sit inside module Full Access**: `hr.data.reset`, `finance.data.reset`, `platform.data.destructive` and `platform.identity.delete`. Guards exist (Super Admin + grant authority), but "Full Access" is the policy people will be given by default. | 20261009100000 | High |
| F3 | **Policies referenced but never seeded**: `finance-statement-preparer` and `finance-statement-approver` appear only in the eligibility classification. Either they were created on staging outside migrations (not reproducible on prod), or the update matches nothing. | 20261030100000 l.293 | Medium |
| F4 | **Overlap / duplication**: Security Administrator vs Security & Access Full Access (differ only by access_review, emergency_access, platform.identity.*). Finance Admin vs Finance Full Access (differ by payment.approve, data.reset). HR Manager is nearly HR Full Access minus payroll. | matrix | Medium |
| F5 | **Approver dependency gaps**: `payroll-finance-approver` has no `hr.module.view` (may not reach the HR payroll screen to release; verify). `sa_permission_dependencies` declares only the order dependencies, and payroll / payment / commission / transfer / leave approvals are not declared. | 20261101100000; matrix | Medium |
| F6 | **Warehouse Operator holds `stock_count.create` + `.verify`.** Verify that the stock-count maker/checker blocks the same person on the same document (no `sa_sod_rules` row for stock count was found in the seeds). | 20260927140000 | Medium |
| F7 | **DB reads not aligned with S&A**: `orders_select` is tenant-only, `stock_transfers_manage_hq` FOR ALL lets any HQ account read all transfers, and `qr_batches` / `return_cases` SELECT use legacy levels. Menu, route and API now ask S&A, but these tables do not. | SUPPLY_CHAIN_ACCESS_COVERAGE §4, ORDER_VIEW §6 | High (data exposure for transfers) |
| F8 | **Partner backfill grants on HQ-only policies**: hr-internal-directory-viewer and profile-administrator on MFG/SHOP/WH, plus Customer & Growth viewers on MFG. | ELIGIBILITY §7 | Medium |
| F9 | **Many dependent migrations are unapplied** (20261028, 20261030, 20261101, 20261102*, 20261103, 20261108, 20261109 …). Policies the UI shows may not exist in a given environment. | MEMORY / headers | Process risk |
| F10 | `hr.ai.use` is legacy `() => true` and gates Finance / C&G assistant tools that read with the service client. | SUPPLY_CHAIN_ACCESS_COVERAGE §4.6 | Medium |

## B.4 Top 5 recommendations

Ranked by operational need × gap × risk, preferring correction over a new policy.

### 1. P0 — Correct the module Full Access policies (enhance existing; Small–Medium)

* Remove `hr.data.reset`, `finance.data.reset`, `platform.data.destructive` and `platform.identity.delete` from Full Access
  policies, and keep them only in dedicated break-glass policies:
  * `hr-data-reset-administrator` already exists;
  * **Finance Data Reset Administrator** — new, existing key;
  * **Platform Data Maintenance Administrator** — new, existing keys.
* Turn on `enforce` for `payroll-prepare-approve` and `payment-request-maker-checker`, so that a Full Access holder can still
  do both steps, just never on the same document.

| Field | Value |
|---|---|
| Module | All |
| Intended users | Module administrators |
| Eligibility | HQ |
| Permissions | existing keys only |
| Data scope | organization |
| Risk | High (fixing) |
| Dependencies | `sa_extend_standard_policy` has no "shrink" counterpart, so this needs a reviewed migration with holder audit. Holders who rely on reset must be granted the narrow policy first. |
| Gap | F1, F2 |
| Effort | Medium |

### 2. P0 — Warehouse Receiving & Dispatch (new; Small)

| Field | Value |
|---|---|
| Module | Supply Chain |
| Intended users | Warehouse storekeepers, logistics |
| Eligibility | HQ, WH |
| Permissions | `warehouse.receipt.post`, `warehouse.shipment.manage`, `inventory.stock.view`, `supply_chain.order.view`, `supply_chain.document.acknowledge` |
| Data scope | warehouse (organization = the warehouse; 20261109 makes this reach) |
| Risk | Medium |
| Dependencies | `order.view` for shipping against orders; QR scan reads (`qr_batches` legacy L40, F7) |
| Gap | Today only SC Full Access can receive or ship. Warehouse Manager explicitly excludes both. |
| Effort | Small |

### 3. P1 — Leave & Attendance Administrator (new; Small)

| Field | Value |
|---|---|
| Module | HR |
| Intended users | HR executives / timekeepers |
| Eligibility | HQ |
| Permissions | `hr.module.view`, `hr.employee.view`, `hr.attendance.manage`, `hr.leave.approve`, `hr.expense.manage` |
| Data scope | organization (HR-wide), distinct from MSS team scope |
| Risk | Medium |
| Dependencies | Declare `hr.leave.approve → hr.employee.view` in `sa_permission_dependencies`. Keep MSS (`hr.mss.leave_approve`) as the line-manager path. |
| Gap | Today it is HR Manager (settings + policy + recruitment) or nothing. |
| Effort | Small |

### 4. P1 — Recruitment & Employee Records Officer (new; Small)

| Field | Value |
|---|---|
| Module | HR |
| Intended users | HR recruiters / records officers |
| Eligibility | HQ |
| Permissions | `hr.module.view`, `hr.employee.view`, `hr.employee.manage`, `hr.contract.view`, `hr.contract.manage`, `hr.onboarding.manage`, `hr.recruitment.manage` |
| Data scope | organization |
| Risk | Medium (personal data) |
| Dependencies | Compensation columns are already column-granted (20261105). Confirm that the records screens never show salary without `hr.compensation.*`. |
| Gap | Same as #3: only HR Manager or HR Full Access |
| Effort | Small |

After #3 and #4, **reduce HR Manager** to supervising HR. It keeps analytics, policy, settings, performance and learning, plus
the operate keys. Alternatively, rename it HR Administrator. That is a business decision (Q3).

### 5. P1 — Reporting Viewer, plus correct the Finance statement policies (Small)

| Field | Value |
|---|---|
| Module | Reporting / Finance |
| Intended users | Management, BI consumers |
| Eligibility | HQ |
| Permissions | `reporting.analytics.view` |
| Data scope | organization |
| Risk | Low–Medium (depends on what the analytics page aggregates) |
| Dependencies | Verify the reporting page's data sources are scope-filtered |
| Gap | The key exists and is assigned to **no** policy at all. F3 (statement policies) must be resolved in the same change: seed them by migration with explicit keys, or remove them from the eligibility list. |
| Effort | Small |

### Next, not in the top 5

| Priority | Candidate | Notes |
|---|---|---|
| P2 | Returns Handler | `inventory.return.request/manage` + `inventory.stock.view` + `order.view`; HQ |
| P2 | Product Catalogue Manager | `product.catalog.view/manage`; HQ |
| P2 | Order Documents / Payment Requester | `supply_chain.document.manage/acknowledge` + `order.view`; SoD vs `finance.payment.approve` |
| P2 | Compensation & Benefits Manager | `hr.compensation.view/manage`, `hr.benefits.manage`; not payroll prepare |
| P2 | Distributor Relationship / Sales Manager | `customer.shop.manage`, `customer.crm.view`, `customer.report.view` |
| P2 | Marketing Campaign Manager | `customer.campaign.manage`, `customer.banner.manage`, `marketing.module.view` |
| P3 | AP / AR clerks that can operate | needs **PROPOSED — NOT IMPLEMENTED** keys `finance.payable.manage`, `finance.receivable.manage`, `finance.payment.request` |
| P3 | Quality Control | needs PROPOSED `inventory.quality.*` |
| P3 | Event Management | needs PROPOSED `customer.event.*` (`/event` today is only a public token page) |
| P3 | HR Position Management | needs PROPOSED `hr.position.view/manage/approve` (hr01–05 tables exist, no keys) |
| P3 | HR Viewer / Auditor (read-only) | needs PROPOSED `hr.payroll.view` without compensation, or a viewer-only compensation key |

Rejected as redundant:

* **HR Administrator** — HR Manager plus HR Full Access already cover it.
* **Finance Administrator** — `finance-admin` exists.
* **Payroll Officer / Approver / Payment Approver / ESS / MSS / RoadTour / Order Approval** — they exist.
* **System Administrator** — Platform Full Access + Root Access.

## B.5 Permission matrix for the top 5

| Permission | 1 FA fix | 2 WH Recv/Dispatch | 3 Leave & Attend. | 4 Records Officer | 5 Reporting Viewer |
|---|---|---|---|---|---|
| hr.data.reset / finance.data.reset / platform.data.destructive / platform.identity.delete | **removed** from FA; break-glass policy only | | | | |
| warehouse.receipt.post, warehouse.shipment.manage | | ✔ | | | |
| inventory.stock.view | | ✔ | | | |
| supply_chain.order.view | | ✔ (supporting) | | | |
| supply_chain.document.acknowledge | | ✔ | | | |
| hr.module.view, hr.employee.view | | | ✔ | ✔ | |
| hr.attendance.manage, hr.leave.approve, hr.expense.manage | | | ✔ | | |
| hr.employee.manage, hr.contract.view/manage, hr.onboarding.manage, hr.recruitment.manage | | | | ✔ | |
| reporting.analytics.view | | | | | ✔ |

## B.6 Security architecture review

| # | Question | Assessment |
|---|---|---|
| 1 | Least privilege / SoD | Narrow policies are good (commission maker/checker split, MSS separate from compensation). Full Access policies concentrate authority, and 4 of 5 SoD rules are `monitor` only (F1). |
| 2 | Approval implies view? | Orders yes (declared dependency). Payroll, payment and commission approvers include their view key in the mapping, but the dependency is **not declared**, so a custom policy can be built with approve-only (F5). |
| 3 | Function vs data scope | Separated correctly: permissions plus scopes (`organization`, `warehouse`, own_record, MSS team in query). The warehouse reach fix (20261109) is unapplied. |
| 4 | Grouping consistency | One taxonomy across all screens (`modules.ts`); now complete for HR. Finance has no "General" leaks. |
| 5 | Standard vs Custom same foundation | Yes. Both are `sa_business_roles`; same evaluator, eligibility trigger, grant-authority guard and audit. Standard is copy-only (`sa_profile_standard_protected`). |
| 6 | Audit of sensitive actions | Assignments, eligibility changes, standard extensions and resets are audited (`sa_log_access_change`, per-holder rows). Decision audit is SHADOW / diagnostic. Not reviewed here: whether export/report reads are audited. |
| 7 | Destructive operations in policies | Yes. They sit inside Full Access (F2). |
| 8 | Menu / route / API / DB alignment | Menu, route and API are largely S&A (nav-access destination table). The DB lags for orders, transfers, QR batches and returns (F7), and legacy L-level rules are still ANDed on some screens. |
| 9 | Grant / revoke / restore / expiry | Per-request evaluation (revocation is immediate). `effective_until` expiry is in every check. Restore exists (20261108, unapplied). Org change ends grants. Consistent by design, but environment-dependent until those migrations are applied. |
| 10 | Growth without duplication | Explicit-list standard policies plus the `sa_standard_policy_drift()` / `sa_extend_standard_policy()` controlled update are sound. Risk: a growing set of one-key "viewer" policies (11 single-key C&G/Platform policies). Prefer function-sized bundles with declared dependencies (as in #2–#4). |

## B.7 Suggested sequence

1. **Environment truth first.** Apply or confirm the pending S&A migrations on staging, in order, and run B.9 SQL. Nothing
   below is safe to design against an unknown baseline (F9).
2. **#1 Full Access correction** and the SoD `enforce` switch. Grant the break-glass policies to the current reset holders
   before removing the keys.
3. **F7 table-level read gates**, starting with `stock_transfers_manage_hq`, as a separate reviewed migration.
4. **#2 Warehouse Receiving & Dispatch** (depends on 20261109).
5. **#3 + #4 HR policies**, then decide on the HR Manager reduction.
6. **#5 Reporting Viewer** and the Finance statement policies (F3).
7. Declare approval → view dependencies for payroll, payment, commission and leave (F5), so the drift/gap report covers
   custom policies.
8. P2 policies, then the P3 items that need new keys.

## B.8 Questions for business owners

1. Should module "Full Access" ever include destructive reset/delete operations, or must those always be a separate,
   time-boxed break-glass grant?
2. Payroll and payment maker/checker: switch from `monitor` to `enforce`? Who is the fallback approver in a small team?
3. HR Manager: should it keep recruitment, records and leave once the narrow policies exist, or become a supervisory policy?
4. Finance Statement Preparer / Approver: which keys should they hold, and do they exist on production?
5. The pending org-type decisions in GROUP_POLICY_ORG_TYPE_ELIGIBILITY §6, especially Order Approver for DIST, Warehouse
   policies for DIST, and Catalogue User for DIST/SHOP.
6. Is `hr.data.reset` meant to be `LEGACY_RETIRED` everywhere? The repo seeds it `SHADOW`.
7. Do AP/AR clerks, Quality Control and Event Management need real operate permissions this quarter, so that new keys must
   be designed?

## B.9 Read-only SQL for manual verification (staging, then production)

```sql
begin transaction read only;

-- Standard policies, status, eligibility, active holders, permissions
select r.role_key, r.name, r.status, r.applicable_org_types,
       (select count(*) from sa_role_assignments a where a.role_id = r.id and a.status = 'active') as active_holders,
       (select string_agg(p.permission_key, ', ' order by p.permission_key)
          from sa_business_role_permissions rp join sa_permissions p on p.id = rp.permission_id
         where rp.role_id = r.id) as permissions
from sa_business_roles r where r.source = 'template' order by r.role_key;

-- Every HR permission with status and migration mode (confirms hr.data.reset is retired/kept)
select p.permission_key, p.status, m.mode
from sa_permissions p left join sa_migration_modes m on m.permission_key = p.permission_key
where p.module = 'hr' order by 1;

-- Active permissions in no standard policy
select p.permission_key from sa_permissions p
where p.status = 'active' and not exists (
  select 1 from sa_business_role_permissions rp join sa_business_roles r on r.id = rp.role_id
  where rp.permission_id = p.id and r.source = 'template') order by 1;

-- Template policies not created by repo migrations (F3)
select role_key, created_at, created_by from sa_business_roles
where source = 'template' and role_key like 'finance-statement-%';

-- SoD rules and their enforcement
select rule_key, left_key, right_key, rule_kind, enforcement, status from sa_sod_rules order by 1;

-- Declared supporting reads, and standard policy gaps (if 20261101100000 is applied)
select * from sa_permission_dependencies order by 1;
select * from sa_standard_policy_dependency_gaps();

-- Drift: registered permissions not in their module Full Access policy (20261009100000)
select * from sa_standard_policy_drift();

rollback;
```

---

# Report C — Implementation of the approved recommendations (2026-10-13)

## C.1 Decisions (business owner)

1. Destructive operations leave the module Full Access policies and live only in break-glass policies. Current holders
   keep access.
2. Payroll prepare→approve and payment request→approve maker/checker: **enforce**.
3. Build Warehouse Receiving & Dispatch, Leave & Attendance Administrator, Recruitment & Employee Records Officer and
   Reporting Viewer.

## C.2 Migration `supabase/migrations/20261110100000_sa_policy_hardening_and_new_standard_policies.sql` (NOT APPLIED)

| § | Change |
|---|---|
| 1 | `sa_standard_policy_coverage.excluded_keys` (reviewed exclusions). `sa_standard_policy_drift()` skips them; its result columns are unchanged. |
| 2 | `sa_narrow_standard_policy(role_key, keys, reason)`: owner-only counterpart of `sa_extend_standard_policy`. It never revokes an assignment and audits `access_profile.standard_narrowed`, plus `assignment.profile_changed` per holder. |
| 3 | Six standard policies, assigned to nobody: Finance Data Reset Administrator, Platform Data Maintenance Administrator, Warehouse Receiving & Dispatch (HQ, WH), Leave & Attendance Administrator, Recruitment & Employee Records Officer, Reporting Viewer. The coverage record is also added for the existing HR Data Reset Administrator. |
| 4 | Every **current active** holder of a Full Access policy that still holds a destructive key receives the break-glass policy first: same membership, scopes and dates, audited `assignment.granted` with `transferred_from`. Staging: 2 accounts (1 Finance, 1 Platform). |
| 5 | The destructive keys are removed from HR & Payroll (→25), Finance (→12) and Platform & Settings (→9) Full Access, and the descriptions are updated. |
| 6 | `payroll-prepare-approve` and `payment-request-maker-checker` are set to `enforce`, audited `sod.rule_enforcement_changed`. |
| 7 | 11 declared supporting reads (payroll, payment, commission, MSS and HR leave approvals, HR maintenance, shipment). |
| 8 | Post-conditions: no destructive key in any Full Access policy, nobody lost a destructive key, exact sets for the new policies, enforcement on, no dependency gaps, drift clean. |

The migration does not change permission keys, migration modes, compatibility roles, custom policies, scopes, RLS or the
evaluator. It is repeat-safe.

**Proof:** `supabase/tests/security/sa_policy_hardening/run.sh` ran on a throwaway PostgreSQL 17 built by `build_replica.sh`
from a read-only staging schema dump plus the S&A configuration rows (synthetic users only). It ran the negative control
(11 checks), then the migration **twice**, then 43 checks. **ALL PASSED.**

### How to run it (you)

Staging first. Localhost shares the staging database, so localhost UAT starts after this.

1. Optional pre-check, read-only: run the B.9 queries; there should be 1 Finance and 1 Platform Full Access holder.
2. Run the whole file as `supabase_admin` (SQL editor or `psql -v ON_ERROR_STOP=1 -f`). It raises and changes nothing if
   a prerequisite or a post-condition fails.
3. Verify:

```sql
select role_key, cardinality(permission_keys), excluded_keys from sa_standard_policy_coverage
 where role_key like '%full-access' or role_key like '%administrator' or role_key in ('warehouse-receiving-dispatch','hr-records-officer','reporting-viewer');
select rule_key, enforcement from sa_sod_rules order by 1;
select action, count(*) from sa_access_change_log where occurred_at > now() - interval '1 hour' group by 1;
```

4. Expected audit rows on staging:
   * `access_profile.standard_seeded` × 6;
   * `assignment.granted` × 2;
   * `access_profile.standard_narrowed` × 3;
   * `assignment.profile_changed` × 2;
   * `sod.rule_enforcement_changed` × 2.

## C.3 App changes

* `group-policies.ts`: `DESTRUCTIVE_PERMISSIONS` (in `OUTSIDE_FULL_ACCESS`), `BREAK_GLASS_POLICIES` (+ names) and
  `FUNCTIONAL_STANDARD_POLICIES`; the Add User note is reworded.
* `policy-dependencies.ts`: mirror of the 11 new supporting reads.
* `coverage-audit.ts`: parses the new migration (added policies, narrowed keys).
* Reporting:
  * `nav-access.ts`: new `reporting` destination = `reporting.analytics.view`, plus `reportingVisible`.
  * `Sidebar.tsx`: Reporting is shown by the S&A snapshot instead of the legacy rule (HQ/DIST/WH and level ≤ 40).
  * `app/reporting/page.tsx`: server guard, so the menu, the page and every `/api/reporting` route make the same decision.
* `AccessProfilesPanel.tsx`: a "Break-glass" badge. The Full Access info names the destructive operations that are not
  included and where they live.
* Side effect, intended: HR & Payroll and Finance Full Access no longer hold a sensitive permission. They are now offered
  in Add User like other policies. Security & Access and Platform & Settings Full Access still need a grantor who holds
  their sensitive keys.
* Tests:
  * new `policy-hardening.test.ts` (9 tests, TS ↔ SQL lock-step);
  * updated `group-policies.test.ts` and `order-view.test.ts`.
* Full suite: 5815 passed, 13 failed. All 13 failures are in files this work does not touch: emergency-access ×2,
  ui-contract, route-coverage (`hr/job-classifications`), order access ×2, organizations ×5, inventory ×3 and the Add User
  identity mock.

## C.4 Localhost UAT checklist (after the migration is on staging)

1. **Group Policies tab:**
   * Finance Data Reset Administrator and Platform Data Maintenance Administrator show a red **Break-glass** badge.
   * HR & Payroll / Finance / Platform & Settings Full Access show 25 / 12 / 9 permissions, and their info lists the
     operations that are not included.
2. The current Finance Full Access holder and the Platform Full Access holder each now also hold the break-glass policy,
   in People & Access, with the same scope. Their Access history shows the grant with the reason.
3. Grant **Finance Full Access** to a test HQ user. They can approve payments, but Reset Accounting Data is refused.
4. Grant **Warehouse Receiving & Dispatch** to a warehouse user (WH membership):
   * Supply Chain → Warehouse Receive / Warehouse Ship open;
   * stock adjustment, transfers approval, products admin and QR batches are not offered.
   * Granting it to a Distributor is refused.
5. Grant **Leave & Attendance Administrator** to a level-50 HQ user. HR opens Leave (types, requests, approval flow),
   Attendance (clock-in/out, timesheets) and Time & Expense; People is read-only; Payroll and Settings are absent.
6. Grant **Recruitment & Employee Records Officer**. HR shows Recruitment, Onboarding and People with edit controls; Payroll,
   Leave approval and Settings are absent.
7. Grant **Reporting Viewer** to a level-50 HQ user. The Reporting menu appears, and the page and its analytics load.
   Revoke it: the menu disappears and `/reporting` shows Access denied.
8. Payroll run:
   * the person who calculated a run cannot approve it (`sod_violation: Payroll prepare vs approve`);
   * another payroll approver can.
   * The same applies to a payment request raised and approved by the same person.
9. Not granted to anyone by the migration: the four functional policies show 0 holders.

## C.5 Follow-ups (not done)

* **F11:** decide whether `finance.data.reset`'s compatibility rule should stop granting legacy-hq / legacy-power-user.
* **F12:** extend Finance Full Access with `finance.statement.*` after the bank-statement branch is merged in.
* **F7:** table-level reads (`stock_transfers_manage_hq` FOR ALL, `orders_select`, `qr_batches`, `return_cases`).
* **P2 / P3 items** in B.4.
