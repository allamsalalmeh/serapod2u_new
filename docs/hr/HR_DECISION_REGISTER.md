# Serapod2U HR — Decision Register

Last verified: 2026-10-26 · HEAD `b6b78002` (E-47, E-48 added; E-46 verified). Earlier: 2026-10-25 (Wave 3 engineering decisions E-25…E-46). Earlier: 2026-10-24 (B2A/B2B implementation) · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

Statuses: **APPROVED** (owner-confirmed or established, documented practice) · **PROPOSED** (recommended in an assessment, not approved) · **PENDING OWNER DECISION** (open question) · **SUPERSEDED** (kept for history).

Rules: rows are never deleted (rule 11). A status change adds a line to §5 History. No approval is recorded without an owner source.

Source abbreviations
- **OWN-FIN** — owner instruction "Cross-Module Finance Integration Architecture Assessment", 2026-10-24 ("The owner has approved the following architecture direction …").
- **OWN-DOC** — owner instruction "HR Master Documentation & Implementation Governance Setup", 2026-10-24 ("Confirmed owner direction includes …").
- **OWN-REM** — owner instruction "HR Remediation Assessment (Continuation)", 2026-10-24 ("Preserve all existing architecture decisions, particularly canonical identity, S&A authorization and controlled Employee Delete/Reset").
- **OWN-HO** — owner instruction "HR Core — New Coder AI Session Handover & Documentation Sync", 2026-10-24 (restates the confirmed attendance decisions; states "No B2 implementation or live migration has been approved by the owner yet").
- **OWN-IMPL** — owner instruction "Serapod2U HR Core — IMPLEMENT B2A and B2B", 2026-10-24 ("Temporary owner-approved implementation defaults" 1–8; B2B rules: OT independent approval, payroll approval blocked until certified, shared CI unchanged; PD-GOV-02 narrow tracking fix). Code + isolated tests only.
- **B0-ENV** / **B0-PLAN** — frozen reports [HR_B0_ENVIRONMENT_VERIFICATION.md](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md) and [HR_B0_REVIEW_AND_B2_PLAN.md](assessments/HR_B0_REVIEW_AND_B2_PLAN.md) (HEAD `1e0830c6`, restored and verified 2026-10-24).
- **MIG-xxxx** — owner decision recorded in a migration header.
- **PMS** — `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`.
- **REM-…** / **FIN-…** — frozen assessment reports (see index §5.3).
- **OWN-W2** — owner directive "SERAPOD2U HR CORE — CONTINUOUS EXECUTION: COMPLETE WAVE 1 AND DEVELOP WAVE 2", 2026-10-25 ("Make routine engineering decisions independently, implement them, test them, document them, and continue"). Implementation + isolated tests + documentation; no live SQL, S&A change, deployment, commit or UAT.

- **OWN-W3** — owner directive "SERAPOD2U HR CORE — MASTER HANDOVER & WAVE 3 CONTINUOUS DEVELOPMENT", 2026-10-25 ("Make routine engineering decisions independently and document them. Pause only the affected work where a genuine security, business-policy or live-environment decision is required"; "for unresolved material policy choices, document alternatives and continue"). Also states: Wave 2 migration `20261221100000` **executed successfully on STAGING by the owner** (record as owner-reported).
---

## 1. Approved decisions

| ID | Topic | Agreed decision | Date & source | Status | Implementation impact | Workstream |
|---|---|---|---|---|---|---|
| D-001 | Programme order | **HR Core first** | 2026-10-24 · OWN-FIN, OWN-DOC | APPROVED | HR Core batches precede Payroll and Finance phases | All |
| D-002 | Finance readiness | **Finance-ready from day one**: HR captures complete, reliable data so Finance integration does not require redesigning HR Core | 2026-10-24 · OWN-FIN, OWN-DOC | APPROVED | Phase A data items (WS-18) in HR Core scope | WS-18 |
| D-003 | Go-live separation | **Payroll and Finance go live separately** (from HR Core and from each other) | 2026-10-24 · OWN-FIN, OWN-DOC | APPROVED | Separate gates; payroll may stop at "awaiting Finance" (see PD-FIN-08) | Future |
| D-004 | Authorization | **Canonical S&A is the single authorization authority** | 2026-10-24 · OWN-DOC, OWN-REM | APPROVED | WS-17; no new legacy evaluators | WS-17 |
| D-005 | Identity | One canonical identity (`public.users`, immutable UUID); `hr_employees` is the employment anchor owning `employee_no` | 2026-10-24 · OWN-REM (preserve); design `HR_ONBOARDING_AND_DATA_RESET.md` | APPROVED | Never delete/re-create anchors to "reset" | WS-01–03 |
| D-006 | Employee delete/reset | Controlled Remove/Reset HR Registration via break-glass `hr.employee.delete` (database-owned, preview token, idempotency, append-only audit); no row deletion | 2026-10-24 · OWN-REM; migration `20261214100000` | APPROVED | Batch B1 apply | WS-02 |
| D-007 | Former users | Archive keeps the UUID and all history; archiving revokes login/access; email/phone may be **released** under control; returning person is reactivated, never re-created | 2026-10-24 · MIG-20261217100000 header ("Decision (owner, 2026-10-24)") | APPROVED | Batch B1 apply; lifecycle B7b builds on it | WS-03 |
| D-008 | Archive reason | Archive & Revoke Access reason is optional; typed email is the single confirmation; release keeps a mandatory reason | 2026-10-24 · MIG-20261218100000 header | APPROVED | — | WS-03 |
| D-009 | Finance integration model | **Shared Finance Integration Framework** in a future phase, rather than independent posting mechanisms per module | 2026-10-24 · OWN-FIN, OWN-DOC | APPROVED (direction) | Design details are PROPOSED (P-F01…) | WS-18, Phase C |
| D-010 | Master data | **Finance owns accounting master data; HR references it** | 2026-10-24 · OWN-FIN, OWN-DOC | APPROVED | HR stops seeding GL accounts (later batch) | WS-18 |
| D-011 | Attendance model | **Hybrid Attendance** | 2026-10-24 · OWN-DOC | APPROVED (direction; details PD-ATT-01) | B4a–c | WS-06–10 |
| D-012 | Normal attendance | **Normal attendance is auto-validated, without daily approval** | 2026-10-24 · OWN-DOC | APPROVED | Exception-based review (B4a) | WS-06, WS-10 |
| D-013 | Corrections | **Attendance corrections require controlled approval** | 2026-10-24 · OWN-DOC | APPROVED (approver model PD-ATT-04) | B4b | WS-08 |
| D-014 | Overtime | **OT approval is separate from attendance** | 2026-10-24 · OWN-DOC | APPROVED | B5 | WS-11 |
| D-015 | Financial posting boundary | Ordinary attendance must not generate accounting journals; only approved financial results proceed to posting through an authorized process | 2026-10-24 · OWN-FIN | APPROVED | Contract design; no attendance→GL path ever | WS-06, WS-18 |
| D-016 | Emergency Access | `20261024110000_sa_emergency_access_enable.sql` is held — do not apply without a decision | PMS row 38 | APPROVED (hold) | Excluded from all batches | WS-17 |
| D-017 | Applied migrations | Applied migration files are never renamed (duplicate-version hazard handled operationally) | PMS "Executive result" | APPROVED (established practice) | Re-stamp only never-applied files | Ops |
| D-018 | Migration application | Migrations are applied by hand per environment, staging first, each file in one transaction, and recorded in PMS | PMS header | APPROVED (established practice) | All DB batches | Ops |
| D-019 | Working mode | Implement only explicitly approved batches; documentation is the source of truth | 2026-10-24 · OWN-DOC | APPROVED | Governance rules in index §6 | All |
| D-021 | HR leave authority (OD-B2A-1, default 1/3) | HR leave approval and organization-wide leave visibility require an explicit **non-legacy** `hr.leave.approve` assignment (or Root Access). Legacy compatibility policies, legacy role levels, delegation and emergency grants never confer leave authority | 2026-10-24 · OWN-IMPL | APPROVED (temporary implementation default) — **implemented** in `20261219100000` (not applied) | Explicit grants needed before staging (BL-11) | WS-12 |
| D-022 | Manager leave approval (OD-B2A-2, default 2) | Direct manager may decide only with explicit `hr.mss.leave_approve` (view: `hr.mss.leave_view`) **and** a verified reporting line (`hr_employees.manager_user_id`, employee onboarded, manager active/not archived/onboarded) | 2026-10-24 · OWN-IMPL | APPROVED (temporary) — implemented | `manager-self-service` grants for line managers | WS-12, WS-13 |
| D-023 | HR leave visibility (OD-B2A-3, default 3) | Organization-wide leave read requires explicit HR permission (`hr.leave.approve` until `hr.leave.view` exists) | 2026-10-24 · OWN-IMPL | APPROVED (temporary) — implemented | — | WS-12 |
| D-024 | Approved-leave cancellation (OD-B2A-4, default 4) | Only explicit HR (or Root) cancels approved leave; employees cancel only draft/pending; approver preserved | 2026-10-24 · OWN-IMPL | APPROVED (temporary until B6) — implemented | — | WS-12 |
| D-025 | Historical rows (OD-B2A-5, default 5) | Existing suspicious rows (self-approved, decided without approver, unknown status) are reported via `hr_leave_containment_review(org)` and never changed | 2026-10-24 · OWN-IMPL | APPROVED — implemented | HR review after staging apply | WS-12 |
| D-026 | Cross-company / HQ→child (OD-B2A-6, default 6) | Cross-company approval forbidden; HQ authority covers its own child organizations only (canonical `sa_org_ancestry`: membership in the request's organization or an ancestor) | 2026-10-24 · OWN-IMPL | APPROVED — implemented | — | WS-12 |
| D-027 | Leave delegation (OD-B2A-7, default 7) | Not honoured in B2A (deferred to B6) | 2026-10-24 · OWN-IMPL | APPROVED — implemented | — | WS-12 |
| D-028 | B2A rollback posture (PD-B2-10, default 8) | Rollback must not restore self-approval or unrestricted data access: the default rollback relaxes only the authority source (legacy compatibility counts again); full revert is emergency-only with a recorded owner decision | 2026-10-24 · OWN-IMPL | APPROVED — implemented (migration header; replica test 50) | — | WS-12 |
| D-029 | Payroll approval lock (OD-B2B-1) | Payroll approval refused (`PAYROLL_STATUTORY_NOT_CERTIFIED`) until `hr_settings.config.payroll.statutory_certified = true`; the flag is never settable through an application route | 2026-10-24 · OWN-IMPL | APPROVED — implemented | Who sets the flag = a later owner-recorded decision (Phase B) | WS-18 |
| D-030 | OT approval (OD-B2B-2) | Every OT request requires independent approval until the full OT workflow (B5): no auto-approval, requester ≠ approver | 2026-10-24 · OWN-IMPL | APPROVED — implemented | — | WS-11 |
| D-031 | Shared CI (OD-B2B-3) | `.github/workflows/ci.yml` is **not** changed until cross-workstream ownership is clear; HR contract and migration-version tests run locally | 2026-10-24 · OWN-IMPL | APPROVED — honoured (no CI change) | Revisit with workstream owners | Governance |
| D-032 | Evidence SQL tracking (PD-GOV-02) | Narrow `.gitignore` exception `!/docs/hr/**/*.sql`; `*.sql` stays ignored elsewhere | 2026-10-24 · OWN-IMPL | APPROVED — implemented (uncommitted) | v2 diagnostic becomes trackable | Governance |
| D-020 | Docs version control (resolves PD-GOV-01) | `docs/hr/**/*.md` is exempt from the global `*.md` ignore via one `.gitignore` exception `!/docs/hr/**/*.md`; Markdown elsewhere stays ignored | 2026-10-24 · owner instruction "HR Documentation Git Tracking Fix" | APPROVED — **implemented**; committed `8add030c` (2026-10-24) · pushed: **No** (branch has no upstream) | All `docs/hr` Markdown becomes trackable once staged and committed | Governance |

### 1.1 Engineering decisions under the OWN-IMPL delegation ("use professional engineering judgment … document the rationale")

| ID | Decision | Rationale | Evidence |
|---|---|---|---|
| E-01 | No status CHECK constraint on `hr_leave_requests`; the guard enforces the vocabulary for API writes and freezes rows with legacy values | A NOT VALID CHECK still applies to re-inserted rows and broke HR Data Management **restore** of historical rows with legacy statuses | Replica test R6 (failed, then fixed); H7b/H7c/H10/H11 |
| E-02 | Audit table `hr_leave_request_events` has no foreign keys and stores the actor as `actor_ref` | Permanent identity deletion and controlled employee delete block on FKs **and** on uuid columns named `…actor_id/…_by/…user_id`; the identity-owned `v_retained` list cannot be edited by HR | Replica E12/E13, I1–I5, C2 |
| E-03 | Guard refuses every API write by an inactive/ARCHIVED account | An archived account may still hold an unexpired token | Replica K4 (failed, then fixed) |
| E-04 | No service-role bypass; only database-owned code (any role other than authenticated/anon/service_role, i.e. SECURITY DEFINER functions owned by the migration owner) is the `maintenance` path, still audited | Owner rule "no blanket SECURITY DEFINER/service-role bypass for user-facing operations"; reset/restore and identity functions must keep working | Replica T11, P1, R3–R8 |
| E-05 | Guard trigger is SECURITY INVOKER; only narrow predicates about `auth.uid()` and the event recorder are SECURITY DEFINER | Least privilege; the guard must see the statement's real role | Migration §2–3 |
| E-06 | Mobile team list keeps its query and relies on B2A RLS (direct reports / explicit HR), excluding own rows, instead of `/api/hr/mss/leave` | The MSS route returns no names; RLS is the authority | `HrMobileLeave.tsx` |
| E-07 | Payroll run label stored in `notes` (no `name` column); OT cancel keeps the record (status `cancelled`) instead of deleting; timesheets never regenerate a submitted/approved period | Column contract; preserve history; fail-closed | Route tests |
| E-09 | Web leave decision: success is shown only when the stored status equals the requested one; every refusal shows the guard's message | Owner requirement "no false-success Leave approval messages" | `HrLeaveRequestsView.decisions.test.tsx` |
| E-10 | A refused approval-history step (`hr_leave_approvals`) does not undo or hide a stored decision; it is flagged (`approvalStepRecorded: false`) and logged | The decision is authoritative and audited in `hr_leave_request_events` | `supabaseRepository.test.ts` |
| E-11 | Leave lists render unknown/legacy status values instead of failing | Guard freezes legacy values (E-01) | View test |
| E-12 | Leave is filed in `users.organization_id` (unchanged); the cross-company employment case gets an explicit message pending P-R14 | No new migration authorized in Wave 1 | `leaveErrors.ts` |
| E-13 | Migration-version collisions are **not** renamed: every HR-owned colliding file has staging effects (KVM2 2026-10-25); pinned by the regression test; S&A-owned `20261215100000_sa_payment_gateway_restriction` handed over. The never-applied Wave 2 file was re-stamped `20261220100000` → `20261221100000` when the inventory workstream created `20261220100000_inventory_cases_and_pcs.sql` concurrently | D-017; owner rule "do not rename applied migrations blindly"; staging has no migration ledger | KVM2 B0 v2 §A; `migration-versions.test.ts` (OWN-W2) |
| E-14 | Mobile leave: half day = single date + explicit morning/afternoon; success only for a stored row / stored status | `hr_leave_requests_half_day_chk`; owner rule "no false success" | `mobileLeave.test.ts`, `HrMobileLeave.test.tsx` (OWN-W2) |
| E-15 | Mobile Approvals tab = HR leave destination **or** MSS team-leave destination; the database still decides each request | B2A manager authority is MSS-based (D-022) | `pages.access.test.tsx` (OWN-W2) |
| E-16 | Employment history baseline: one version per employment, effective from the hire date, labelled `baseline` (earlier changes not reconstructed) | As-of lookups need a version for every date since hire; no fabricated history | Replica E2/E3, V1/V2 (OWN-W2) |
| E-17 | History tables use `*_ref` columns without foreign keys; versions of a permanently deleted (history-free) employment are purged with it; HR profile/statutory tables reference `users` without cascade (they block permanent deletion like other HR records) | Identity deletion plan semantics (E-02); lifecycle review §3 | Replica D1–D5, B1 (OWN-W2) |
| E-18 | Lifecycle guard: archived employees locked; rehire only for a non-archived identity (end date cleared); ending employment stamps the end date; a NEW manager must be active, non-archived, same company, no cycle — also in fresh HR onboarding; existing invalid lines reported, not blocked; restore never re-validated | Lifecycle review D1/D3; owner C1 "archived employees cannot bypass lifecycle restrictions" | Replica L1–L10, O1–O3, H5 (OWN-W2) |
| E-19 | Employment-end effects end active salary, allowances, deductions and position assignments at the end date (rows kept); direct reports are not silently moved | Lifecycle review D2; MSS visibility must change only explicitly | Replica X1–X8, A1–A3 (OWN-W2) |
| E-20 | Reporting-line changes only through explicit HR functions with a mandatory reason, logged; review derives position-hierarchy expectations but never applies them automatically | P-R08 direction ("HR-approved rows only") | Replica R1–R5, S1–S17 (OWN-W2) |
| E-21 | Statutory master data stored once (`hr_employee_statutory_profiles`); the HR Profile sheet's personal data in `hr_employee_profiles`; employee reads own data, edits only self-service fields; statutory edits by explicit HR, never on one's own record; logs hold column names only | No duplicate master source (owner C1/C4); PDPA minimisation | Replica P1–P9, F1–F10, G6–G13 (OWN-W2) |
| E-22 | Future-dated employment changes are refused (no scheduler yet); ending employment is never a field change | PD-LC-01 open; archive is the offboarding path | Replica E4/E5 (OWN-W2) |
| E-23 | Compensation overlap enforced by a trigger with a per-employee advisory lock (no btree_gist dependency); the migration refuses to run if overlaps exist | Extension availability on Supabase; no silent data change | Replica C1–C5 (OWN-W2) |
| E-24 | B3 HR-owned: `() => true` legacy evaluators replaced by the default HR legacy rule; new entry points require explicit non-legacy authority (`hr_actor_has_explicit`, same rule as B2A) | P-R06 direction; D-004; "do not automatically grant access to legacy compatibility users" | `b3-legacy-evaluators.test.ts`; replica S2/E10/G4/G10/F7 (OWN-W2) |
| E-25 | Attendance, correction and OT rows are written only by database functions (server clock, canonical current employment, channel, audit); API roles (anon/authenticated/service_role) are refused by a guard trigger; device time stored as information only | Owner requirement "reliable time records"; negative control N1/N2 proved employees could set their own times and approve their own OT | Replica G1–G4, G3b, N1–N2 (OWN-W3) |
| E-26 | Punctuality: late = arrival after shift start + coalesce(shift grace override, policy "late after"); early = departure before shift end − policy "early leave"; no shift → no punctuality; `grace_minutes` not used for flags (PD-ATT-03 alternatives: per-shift only, two-tier grace) | Uses only the fields HR already maintains; no new rule invented | Replica M2, C10 (OWN-W3) |
| E-27 | Exceptions are review items without payroll/disciplinary effect: late_arrival, early_departure, missing_clock_out, absent_no_record (policy workday, not a national/work-state holiday, no approved leave, from hire date), non_working_day_work, manual_entry; detection is idempotent, re-run on every capture event and by HR "Check this range" (≤ 62 days); open items whose cause disappears are cleared. No scheduler (PD-ATT-06 SLA open) | D-012; no cron change authorized | Replica X1–X9, RS8 (OWN-W3) |
| E-28 | Reviewer of exceptions and corrections: explicit HR `hr.attendance.manage` of the employee's company, or the direct manager with the REQUESTED `hr.mss.attendance_approve` + verified reporting line (forward-compatible; SA-R6); never the employee or the requester (PD-ATT-04/06 alternatives: manager-first then HR; two-step) | D-013; same authority rule as B2A/Wave 2 | Replica X10–X16, C3–C4, C10 (OWN-W3) |
| E-29 | HR manual entry is recorded immediately (source hr_manual, reason) with a `manual_entry` review item that only ANOTHER HR person may confirm; an HR change of an existing entry is a correction (kind hr_adjustment) decided by someone else (alternative: approval before the entry exists) | Maker-checker without blocking payroll-relevant data capture | Replica M1–M14, C11–C13 (OWN-W3) |
| E-30 | Corrections: one pending per entry/day; missing-day correction creates the entry on approval (source correction); originals kept on the correction and in the audit (before/after); overlaps refused; rejection needs a comment; requester may withdraw | D-013, history preservation | Replica C1–C17 (OWN-W3) |
| E-31 | Excel import: browser reads, database validates; mapping by canonical employee number and/or e-mail (must agree); DD/MM/YYYY accepted; exact duplicates and overlaps are skipped, never overwritten; same file (SHA-256) committed once per company; preview expires after 24 h; commit re-validates and requires the previewed count; imported rows auto-validated like other channels; the importer may commit their own preview (PD-ATT-05 alternatives: overwrite-with-review, second-person commit) | Never lose recorded attendance; idempotent | Replica I1–I11 (OWN-W3) |
| E-32 | Timesheets stay derived weekly summaries; clock events never touch a submitted/approved/rejected period (fixes D3-1, the clock route reset approved periods to pending) — PD-ATT-07 still open | Fail-safe | Replica A10 (OWN-W3) |
| E-33 | OT: one active request per employee and day; 15–720 min; post ≤ today, pre ≥ today, ≤ 60 days old; day type from the calendar; policy-cap and recorded-time flags inform the approver (never auto-refuse/approve); partial approval; rejection comment; HR-only cancellation of approved OT with reason; append-only history; idempotency key; no rate/pay calculation; `payroll_consumed_ref` slot | D-014, D-030; no uncertified payroll logic | Replica O1–O22 (OWN-W3) |
| E-34 | OT approver default (PD-OT-01 open): explicit HR `hr.attendance.manage`, or the direct manager with the REQUESTED `hr.mss.overtime_approve` (SA-R7). PD-OT-02: both pre and post requests allowed. PD-OT-03: `approved_minutes` recorded as the candidate payroll source, not consumed | Owner can switch by S&A grants only | Replica O5–O8, O20 (OWN-W3) |
| E-35 | Leave ledger append-only (days only); `hr_leave_balances` = database projection (entitled + carried forward + adjustment − taken − pending), unique per employee/type/year; opening balance preserves every AVAILABLE balance (stored-vs-approved difference kept as an explicit reconciliation line); migration refuses duplicate balance keys | P-R04 direction; no silent data change (E-23 pattern) | Replica B0–B9, L0 (OWN-W3) |
| E-36 | Working days by the database for each employee submission, content edit and draft submission: policy workdays, national + work-state holidays (Wave 2 statutory work state), half day 0.5 on one date, cross-year split; historical/maintenance rows untouched | Owner requirement "public holiday and work calendar integration" | Replica L1–L4, N3 (OWN-W3) |
| E-37 | Balance enforcement only where an entitlement exists for that type and year (otherwise accepted with a warning in the quote); re-checked at approval (PD-LV-01 open) | Avoid blocking current staging use before entitlements are set up | Replica L8–L9, L15 (OWN-W3) |
| E-38 | Duplicate leave: a submitted/approved request may not overlap the employee's own submitted/approved leave (morning/afternoon halves may share a date; drafts may overlap until submitted) | Duplicate-submission protection; B2A after-test fixtures deliberately overlap, so that suite runs before Wave 3 | Replica L3, BA7–BA8 (OWN-W3) |
| E-39 | Entitlement run uses the leave type's OWN tiers (completed years of service at 1 January) and pro-rata setting (months remaining incl. hire month / 12, the type's rounding, whole days); skips existing entitlements and the actor's own record; preview first; statutory minima NOT enforced (PD-LV-01) | Uses HR-maintained configuration; no legal rule invented | Replica L17–L21 (OWN-W3) |
| E-40 | Carry-forward run: capped by the type's maxDays, skips employees with pending requests, idempotent; expiry/forfeiture NOT automated (PD-LV-02) | Owner decision pending | Replica L22–L24 (OWN-W3) |
| E-41 | Leave balance administration requires explicit `hr.leave.approve` (until `hr.leave.manage`, PD-SA-01) in the employee's company; never on one's own record; reason mandatory | D-021/D-023 rule | Replica L5–L7 (OWN-W3) |
| E-42 | Wave 3 transactional tables are in HR Data Management reset scope (delete with snapshot, restorable); append-only tables allow DELETE only by database-owned code; triggers never re-post during restore | HR reset must keep working (E-04 pattern) | Replica RS1–RS10 (OWN-W3) |
| E-43 | Wave 3 screens live inside existing destinations (HR → Attendance → Clock In / Out; HR → Leave → Leave Requests; mobile attendance/leave); no change to S&A navigation files (proposal SA-R11 / B8) | S&A owns nav-access | — (OWN-W3) |
| E-44 | Deployment coupling: both Wave 3 migrations and the Wave 3 build go to an environment together (old build refused by the guard; new build on old DB → 503 "not installed") | Fail closed, no silent fallback to client-time writes | Route tests (503) (OWN-W3) |
| E-45 | Wave 1/2 defects fixed: D3-1 approved timesheet reset by clock-out; D3-2 mobile direct writes with device time and no worked minutes; D3-3 own-OT approval via RLS; D3-4 remaining-balance formula; D3-5 client-calculated leave days | Found in current code during Wave 3 | Wave 3 README §3 (OWN-W3) |
| E-46 | Wave 2 staging application recorded as **owner-reported (2026-10-25, executed without error)**; marked verified only after the read-only body-hash check (X-1: 26/26) — **verified 2026-10-26 (26/26)** | Rule 9 (never mark applied without evidence) | — (OWN-W3) |
| E-47 | `WP` / `Wilayah Persekutuan` / `Federal Territory` holiday labels count for KUL, LBN and PJY work states (optional correction `20261224100000_hr_w3_wp_holiday_alias.sql`, replaces only `hr_att_day_type`; staging has one `WP` holiday that matched nobody). Not applied; owner may instead relabel the holiday | Staging data 2026-10-26 (B6); safer than renaming data | Replica WP1–WP6, 411/411 (OWN-W3) |
| E-48 | Owner `tsc` on the Mac runs with `NODE_OPTIONS=--max-old-space-size=8192`; a crash (exit ≥ 128 / heap out of memory) is reported as **no result**, never as 0 errors | Mac run 2026-10-26 exit 134 | `local_verify_isolated.sh` (OWN-W3) |
| E-08 | Retired four broken auto-setup actions (410) incl. `enable_overtime_ea1955` (found by the contract test: wrote a non-existent column of a system table and reported success) | Fail-closed configuration | `b2b-retired-and-holidays.test.ts` |

## 2. Proposed decisions (from assessments — not approved)

| ID | Topic | Proposal | Source | Status | Impact if approved | Workstream |
|---|---|---|---|---|---|---|
| P-R01 | Migration stamping | New migrations stamped after `20261218100000`, unique version; add CI duplicate-version check | REM dependency matrix §3.2 | PROPOSED | All DB batches | Ops |
| P-R02 | Leave containment | Transition-guard trigger + narrowed SELECT on `hr_leave_requests` before the full leave backend | REM leave design §10 | PROPOSED | B2 | WS-12 |
| P-R03 | Payroll fail-closed | Fix column contract; fail runs on any line error; block approval while `payroll.statutory_certified=false` | REM payroll §9 | PROPOSED | B2 | WS-18 |
| P-R04 | Leave architecture | Database-owned leave functions, append-only ledger (days only), balances as projection, no client writes | REM leave design | PROPOSED | B6 | WS-12 |
| P-R05 | Leave keys | New S&A keys `hr.leave.manage`, `hr.leave.view`; plus `hr.employee.view_sensitive`, optional `hr.mss.overtime_approve` — LEGACY_RETIRED from birth | REM S&A plan §3 | PROPOSED → see PD-SA-01 | B3 | WS-17 |
| P-R06 | S&A rollout | Remove `() => true` evaluators; production SHADOW→NEW_ENFORCED in waves; retire `legacy-power-user`/`legacy-hq` for HR keys after explicit grants | REM S&A plan §5 | PROPOSED → PD-SA-02 | B3 | WS-17 |
| P-R07 | HR Permissions screen | Replace with read-only S&A panel; legacy store APIs return 410 | REM S&A plan §2 | PROPOSED | B3 | WS-17 |
| P-R08 | Reporting lines | Employee reporting authoritative for workflows; HR-approved reconciliation from position relationships | REM lifecycle D5 | PROPOSED | B7a | WS-05 |
| P-R09 | Separation | Scheduled separation (last working date, reason) decoupled from Archive & Revoke Access | REM lifecycle D3 | PROPOSED → PD-LC-01 | B7b | WS-03 |
| P-R10 | Navigation | Hide mock Approval Flow; expose Payroll Runs & Public Holidays; Settings duplicates redirect to People | REM sequence §3 | PROPOSED | B2, B8 | WS-16 |
| P-R11 | B2 split | Implement B2 as two separate batches: **B2A — Leave Security Containment** and **B2B — Operational Repairs** | B0-PLAN §4.6 (verified 2026-10-24); OWN-HO | PROPOSED (not approved) | Roadmap §2a; B2A first | WS-12, WS-11, WS-16, WS-18 |
| P-R12 | Leave authority vs legacy compatibility | HR leave authority never derives from legacy compatibility policies (`legacy-hq`, `legacy-power-user`, `legacy-sa`), delegation or emergency access | B0-PLAN §2.2, §4.6 (proposed there as "P-R11"; renumbered because P-R11 was already allocated) | PROPOSED — decided via OD-B2A-1 | B2A | WS-12, WS-17 |
| P-R13 | B2A design | Guard trigger `hr_leave_requests_guard` (SECURITY DEFINER), authority model SELF/MANAGER/HR/SERVICE, RLS replacement on `hr_leave_requests`/`hr_leave_approvals`/`hr_leave_balances`, append-only `hr_leave_request_events` (no reason text/dates), status CHECK `NOT VALID`, service-role bypass for reset/restore | B0-PLAN Task 2, §4.1 | PROPOSED (design reference; approval = B2A batch approval) | Migration `20261219100000_hr_leave_containment_guard` | WS-12 |
| P-F01 | Legal entity | One HQ organization = one legal entity/ledger for V1 | FIN roadmap D1 | PROPOSED | Contract, payroll GL | WS-18 |
| P-F02 | Cost centre | Cost centre is a Finance master, separate from departments; HR maintains an effective-dated mapping; employment versions carry a nullable slot now | FIN roadmap D2 | PROPOSED | B7c slot | WS-18 |
| P-F03 | Canonical payroll GL path | `post_payroll_run_to_gl` family (Model 1 `payroll_components`/`payroll_component_gl_map`); retire `hr_post_payroll_run_to_gl` + `hr_gl_mappings` for payroll (no modification now) | FIN roadmap D3; governance §5 | PROPOSED | Phase B | Future |
| P-F04 | Transport | In-database transactional outbox + cron lease worker (no broker, no internal REST) | FIN roadmap D4 | PROPOSED | Phase C | Future |
| P-F05 | Posting keys | Sources send semantic keys (payroll component codes), never GL accounts | FIN roadmap D5 | PROPOSED | Phase B/C | Future |
| P-F06 | Payroll acceptance | Payroll postings always require manual Finance acceptance in V1 | FIN roadmap D6 | PROPOSED | Phase C | Future |
| P-F07 | Release semantics | `hr.payroll.release` = submit to Finance; journal writing needs Finance keys (S&A change) | FIN roadmap D7 | PROPOSED | Phase C | WS-17 |
| P-F09 | Pull-forward | Pull employment versions, compensation integrity and statutory profile (A1/A2/A4) into HR Core scope | FIN roadmap D9 | PROPOSED (already listed in scope as WS-18 items; approval confirms go-live gating) | B7c | WS-18 |
| P-F10 | Commission expense | Commission expense recognised only via payroll; transfer `gl_journal_id` stays unused | FIN roadmap D10 | PROPOSED | Phase B | WS-15 |
| P-G01 | Docs version control | Add `!/docs/hr/` and `!/docs/hr/**` to `.gitignore` (currently `*.md` is ignored) | This setup, 2026-10-24 | SUPERSEDED by D-020 (implemented rule is `!/docs/hr/**/*.md`) | Makes `docs/hr` the tracked source of truth | Governance |
| P-R14 | B2A leave filing organization | Allow self-submission in the organization of the employee's completed `hr_employees` record instead of only `users.organization_id` | Wave 1, BL-19 | **NOT REQUIRED** (closure 2026-10-24): Identity Stage 2 keeps the only current employment in `users.organization_id`; other records are history — recommend reject | `hr_leave_requests_b2a_insert` (unchanged) | WS-12 |

## 3. Pending owner decisions (open questions)

| ID | Question | Why it matters | Blocks |
|---|---|---|---|
| PD-ATT-01 | Which capture channels make up "Hybrid Attendance" (web, mobile, HR manual entry, Excel import, others such as devices)? Is any channel restricted by role or location? | Data model and channel field | B4a–c |
| PD-ATT-02 | Mobile clock-in controls: location/geofence, device binding, photo, offline capture? Which are required for V1? | Mobile scope (WS-07) | B4a |
| PD-ATT-03 | Auto-validation and exception rules: grace minutes, late/early thresholds, missing clock-out cut-off, absence without leave, rest-day/holiday work — use existing `hr_attendance_policies` fields or per-shift rules? | Exception engine | B4a |
| PD-ATT-04 | Who approves corrections and HR manual entries (direct manager via MSS, HR, or two-step)? Can HR manual entries bypass approval? | Controlled approval (D-013) | B4b |
| PD-ATT-05 | Excel import: template columns, who may import, whether imported rows are auto-validated or always reviewed, handling of overlaps with clocked entries | Import design | B4c |
| PD-ATT-06 | Exception review owner and SLA: manager first then HR? What happens to unresolved exceptions at payroll cut-off? | Review queue | B4a |
| PD-ATT-07 | Do approved timesheets remain required once attendance is auto-validated, or become a derived summary? | Avoids duplicate approval | B4a |
| PD-ATT-08 | Attendance lock: after which point (payroll cut-off) are entries immutable except via corrections? | Finance-ready integrity | B4a |
| PD-OT-01 | OT approver: direct manager (MSS), HR, or both? | B5 | B5 |
| PD-OT-02 | Pre-approval required before OT is worked, post-approval, or both allowed? | B5 | B5 |
| PD-OT-03 | Approved OT requests as the sole payroll OT source (vs timesheet OT minutes)? | Prevents double pay | B5, Phase B |
| PD-LV-01 | Leave entitlement policy: statutory minimum (Employment Act tiers) or company policy above minimum; per leave type defaults | Seeds & entitlement run | B6 |
| PD-LV-02 | Carry-forward caps and expiry per type; forfeiture rule | Year-end close | B6 |
| PD-LV-03 | Approval chain default (manager → HR?) and auto-approve/escalation timing | Chains | B6 |
| PD-LV-04 | Encashment of untaken annual leave on separation — enable? | Final pay | B6, Phase B |
| PD-LC-01 | Adopt scheduled separation (P-R09) or keep Archive as the only end-of-employment action for V1? | Offboarding design | B7b |
| PD-LC-02 | Archive with direct reports: block until reassigned, or auto-reassign to the archived person's manager? | Reporting integrity | B7b |
| PD-LC-03 | Former-employee documents: HR-mediated export only, or limited portal access? | Compliance | B7b |
| PD-SA-01 | Approve new keys (P-R05) | Leave/profile authorization | B3, B6 |
| PD-SA-02 | Approve production enforcement waves and compatibility-policy retirement for HR keys (P-R06) | Production authority | B3 |
| PD-FIN-01…10 | Finance proposals P-F01…P-F07, P-F09, P-F10 (item 8 is the question PD-FIN-08 below) | Phase B/C design | Phase B/C |
| PD-FIN-08 | Payroll go-live before Finance: use canonical `post_payroll_run_to_gl` as a bridge, or stop at "awaiting Finance"? | Payroll gate | Phase B |
| PD-B2-01 *(SUPERSEDED → OD-B2A-2; kept for history)* | **Direct-manager leave approval** — may the direct manager (`hr_employees.manager_user_id`) approve a direct report's leave through MSS on that relation alone, or must they also hold `hr.leave.approve`? | Today's legacy RLS branch lets any `role_level ≤ 20` user, and the employee themself, update any same-org request | B2A (refines PD-LV-03) |
| PD-B2-02 *(SUPERSEDED → OD-B2A-1 (+ OD-B2A-6); kept for history)* | **Explicit HR leave approval** — which people are legitimate HR leave approvers? Must HR approval require an explicit `hr.leave.approve` assignment (not role level, not a compatibility policy)? Current holders are **not** assumed legitimate | Prevents silent widening/narrowing of approval authority | B2A |
| PD-B2-03 *(SUPERSEDED → OD-B2A-6; kept for history)* | **HQ-to-child organization authority** — may HQ HR view/approve leave for employees of child organizations, or is authority same-organization only (current policies)? | Determines the org predicate in the containment policies | B2A |
| PD-B2-04 *(SUPERSEDED → OD-B2A-1 / P-R12; kept for history)* | **Legacy compatibility grants for leave** — during B2A, may `hr.leave.approve` still be satisfied via legacy compatibility policies / the `sa_rls_gate` legacy branch, or is leave the first key to require explicit grants? (sub-case of PD-SA-02; no S&A grant/policy change in B2A either way) | Containment is ineffective if the legacy branch still admits broad HR roles | B2A, B3 |
| PD-B2-05 *(SUPERSEDED → OD-B2A-4; kept for history)* | **Approved-leave cancellation** — who may cancel approved leave (employee request + approver confirmation, approver only, HR only), is a reason mandatory, and how is the balance restored before the B6 ledger exists? | Transition guard must allow exactly these transitions | B2A, B6 |
| PD-B2-06 *(SUPERSEDED → OD-B2A-2 + B0-PLAN §2.7; kept for history)* | **Manager Self-Service leave scope** — MSS team leave list = direct reports only (mobile currently lists all same-org pending requests); are additional/dotted-line managers included? | Privacy; links S-05.3 | B2A |
| PD-B2-07 *(SUPERSEDED → OD-B2B-2; kept for history)* | **OT approval behaviour (B2B repair)** — (a) refuse requester = approver; (b) keep or remove the policy auto-approve that records the requester as approver; (c) approver = `hr.attendance.manage` holder until PD-OT-01 is decided? | Minimal API repair without pre-empting B5 | B2B (precedes PD-OT-01…03) |
| PD-B2-08 *(SUPERSEDED → OD-B2B-1; kept for history)* | **Payroll approval lock** — block payroll approval while statutory calculation is uncertified (P-R03): confirm the control (flag name/location) and who may lift it | Fail-closed behaviour | B2B |
| PD-B2-09 *(SUPERSEDED → OD-B2B-3; kept for history)* | **Shared CI changes** — may B2B add the duplicate-migration-version check and HR column-contract test to the shared `.github/workflows/ci.yml` (affects every workstream on `Enhancement03`), or should they run as HR-local test files only? | Shared-branch safety (P-R01) | B2B |
| **OD-B2A-1** *(DECIDED → D-021)* | HR leave authority = explicit **non-legacy** `hr.leave.approve` assignment or Root; legacy-compat-only holders lose leave approval and org-wide leave visibility | 25 staging users are compat-only (BL-11); legitimate approvers need explicit grants first | B2A |
| **OD-B2A-2** *(DECIDED → D-022)* | Manager approval requires the `manager-self-service` policy (`hr.mss.leave_approve`/`hr.mss.leave_view`) **and** a verified direct-report relation (`hr_employees.manager_user_id`, active non-archived onboarded manager); no dotted-line managers | New capability for line managers; grants needed | B2A |
| **OD-B2A-3** *(DECIDED → D-023)* | Organization-wide HR read of leave uses explicit `hr.leave.approve` until `hr.leave.view` exists (B3/B6) | Leave confidentiality | B2A |
| **OD-B2A-4** *(DECIDED → D-024)* | Only explicit HR may cancel approved leave; employees cannot cancel after approval in B2A | Cancellation path | B2A |
| **OD-B2A-5** *(DECIDED → D-025)* | Existing self-approved or approver-less rows are **reported** to HR, not altered | Historical records | B2A |
| **OD-B2A-6** *(DECIDED → D-026)* | Explicit-HR check: non-legacy assignment on an active membership **in the request's organization or its HQ company** (stricter) vs any active membership (looser, cross-org residual). Confirm whether HQ HR approves for child organizations | HQ→child scope | B2A |
| **OD-B2A-7** *(DECIDED → D-027)* | Leave delegation (`hr_delegation_rules`) **not** honoured in B2A (B6 implements it) | Avoids an unreviewed authority path | B2A |
| **OD-B2B-1** *(DECIDED → D-029)* | Payroll approval fully blocked (`PAYROLL_STATUTORY_NOT_CERTIFIED`) until statutory certification (Phase B) | Fail-closed payroll | B2B |
| **OD-B2B-2** *(DECIDED → D-030)* | OT when policy does not require approval: auto-approve with no approver recorded, **or** always require approval until B5 | Removes requester self-approval | B2B |
| **OD-B2B-3** *(DECIDED → D-031)* | Add `npm test -- src/lib/hr` to the **shared** `.github/workflows/ci.yml` | Affects every workstream | B2B |
| PD-B2-10 *(DECIDED → D-028)* | **B2A rollback posture** (new at reconciliation; not in B0-PLAN). The plan's rollback restores the previous policies verbatim, which **re-opens SEC-1…3**. Options: (a) full verbatim restore as planned; (b) "safe rollback" — keep the insert/self-approval/visibility restrictions and relax only the authority helper (e.g. temporarily honour compat holders) | Owner asked for rollback that does not reintroduce insecure access | B2A |
| PD-GOV-02 *(DECIDED → D-032)* | Version-control the v2 diagnostic: add a narrow `.gitignore` exception for `docs/hr/**/*.sql` (D-020 covers `.md` only), or keep `.sql` evidence untracked | Evidence integrity (BL-13) | Governance |
| PD-GOV-01 | Approve `.gitignore` allowlist for `docs/hr/` (P-G01) | Version control of these docs | **Decided → D-020** (2026-10-24). Kept for history. |

### 3.1 Recommended safe defaults for interim PD-B2-01…09 — **SUPERSEDED (history only)**; current recommendations are in §3.3

| ID | Recommended default |
|---|---|
| PD-B2-01 | Direct manager may approve **only** direct reports, and only when also holding `hr.leave.approve` **or** `hr.mss.leave_approve`; never own request |
| PD-B2-02 | HR approval requires an explicit, named `hr.leave.approve` assignment; owner reviews the current holder list (from B0 live evidence) before B2A goes to staging |
| PD-B2-03 | Same-organization only for V1; HQ→child authority deferred to B3 as an explicit S&A scope decision |
| PD-B2-04 | B2A policies ignore role level and do not widen access; no S&A grant or policy change in B2A; compat retirement stays in B3 |
| PD-B2-05 | Employee may cancel own **pending** leave; cancelling **approved** leave requires HR (`hr.leave.approve`) with mandatory reason and audit; balances restored by the same guarded function |
| PD-B2-06 | Direct reports only; no dotted-line managers until S-05.3 |
| PD-B2-07 | Refuse requester = approver in every path; auto-approve kept only if policy says so, recorded as system approval (approver null + reason), not as the requester |
| PD-B2-08 | Block approval while uncertified; flag lifted only by owner-recorded decision; no new S&A key |
| PD-B2-09 | HR-local tests only in B2B; shared CI change proposed separately to the owner |

### 3.2 Interim → original B2 decision ID reconciliation (2026-10-24)

The interim IDs were created while B0-PLAN was missing. They are **superseded, not merged**: where an interim item contained a point the original does not, the residual is stated.

| Interim | Original | Relationship | Residual not covered by the original |
|---|---|---|---|
| PD-B2-01 Direct-manager approval | OD-B2A-2 | Equivalent; original is stricter (MSS policy **and** direct report; HR key alone does not make a manager an approver) | — |
| PD-B2-02 Explicit HR approval | OD-B2A-1, OD-B2A-6 | Equivalent (authority) + membership scope | — |
| PD-B2-03 HQ→child authority | OD-B2A-6 | Covered as the "stricter vs looser membership" choice; HQ-HR-for-child confirmation asked there | Recommendations differ: interim default was same-organization only; B0-PLAN recommends request org **or its HQ company** — owner chooses |
| PD-B2-04 Legacy compat grants for leave | OD-B2A-1 (+ P-R12) | Equivalent; compat never confers leave authority | No S&A grant/policy change in B2A — preserved as a boundary (B0-PLAN §4.4) |
| PD-B2-05 Approved-leave cancellation | OD-B2A-4 | Equivalent (HR only in B2A) | Balance restoration: none needed — no app code writes balances (B0-PLAN §2.1) |
| PD-B2-06 MSS leave scope | OD-B2A-2 + B0-PLAN §2.7 (team tab via `/api/hr/mss/leave`, gated on `hr.mss.leave_view`) | Covered by design | Dotted-line managers excluded by design (S-05.3) |
| PD-B2-07 OT approval behaviour | OD-B2B-2 | Equivalent (auto-approve question); requester ≠ approver is fixed design, not a decision | — |
| PD-B2-08 Payroll approval lock | OD-B2B-1 | Equivalent; mechanism `hr_settings.config.payroll.statutory_certified` | Who may set the flag — not stated in B0-PLAN; record with OD-B2B-1 |
| PD-B2-09 Shared CI | OD-B2B-3 | Equivalent | — |
| — | OD-B2A-3, OD-B2A-5, OD-B2A-7 | No interim equivalent | — |
| PD-B2-10 (new) | — | Not in B0-PLAN | Open |

### 3.3 Recommendations for OD-B2A/OD-B2B (from B0-PLAN §4.7 — **not approved**)

OD-B2A-1 approve after explicit grants · OD-B2A-2 approve, assign `manager-self-service` · OD-B2A-3 approve (interim) · OD-B2A-4 approve (interim until B6) · OD-B2A-5 approve · OD-B2A-6 stricter option, confirm HQ HR teams · OD-B2A-7 approve · OD-B2B-1 approve · OD-B2B-2 always require approval until B5 · OD-B2B-3 approve with notice. PD-B2-10 (this reconciliation's recommendation): option (b), with option (a) kept as emergency fallback only.

### 3.4 Wave 3 interim engineering defaults for open owner decisions (2026-10-25 — owner may change them)

| Open item | Interim default implemented | Alternatives for the owner |
|---|---|---|
| PD-ATT-01 channels | web, mobile, HR manual, Excel import, approved correction (E-25) | add device/kiosk channel; restrict channels by role |
| PD-ATT-02 mobile controls | none beyond server time + channel + device time (no location/photo/device binding) | geofence; device binding; photo; offline capture |
| PD-ATT-03 rules | existing policy/shift fields (E-26, E-27) | per-shift rules; separate grace tiers; absence only for scheduled shifts |
| PD-ATT-04 approver | explicit HR or MSS manager with `hr.mss.attendance_approve` (E-28); HR entries maker-checker (E-29) | manager then HR (two-step); HR only; HR manual entries without review |
| PD-ATT-05 import | HR imports; conflicts skipped; same file once; auto-validated (E-31) | overwrite with review; second-person commit; per-row review |
| PD-ATT-06 review owner/SLA | HR + (future) MSS; no SLA, no cut-off action | manager first with escalation after N days; auto-close at payroll cut-off |
| PD-ATT-07 timesheets | derived weekly summaries, existing approval kept (E-32) | drop timesheet approval; monthly summaries |
| PD-ATT-08 lock | not implemented | lock after payroll cut-off; corrections only via reversal |
| PD-OT-01 approver | HR or MSS manager with `hr.mss.overtime_approve` (E-34) | manager only; manager then HR |
| PD-OT-02 pre/post | both allowed | pre-approval mandatory except emergencies |
| PD-OT-03 payroll source | `approved_minutes` recorded, not consumed | timesheet OT minutes; min(approved, recorded) |
| PD-LV-01 entitlements | type tiers/pro-rata from HR configuration; enforcement only where an entitlement exists (E-37, E-39) | statutory minima enforced; always enforce (block when no entitlement) |
| PD-LV-02 carry-forward | HR-run, capped, no expiry (E-40) | automatic expiry after N months; forfeiture job |
| PD-LV-03 chain | B2A single step (manager with MSS or HR) | manager → HR two-step; auto-escalation |
| PD-LV-04 encashment | not implemented | encash on separation (Phase B payroll) |

## 4. Superseded decisions

| ID | Topic | Former decision | Superseded by | Date & source |
|---|---|---|---|---|
| S-001 | Archived identifiers | Archive keeps email/phone reserved forever (`20260929160000_identity_stage2_archive_keeps_identifiers`) | D-007 (controlled release) | 2026-10-24 · MIG-20261217100000 header |
| S-003 | B2 decision IDs | Interim PD-B2-01…09 (created 2026-10-24 while B0-PLAN was missing) | OD-B2A-1…7, OD-B2B-1…3 (mapping §3.2) | 2026-10-24 · B0-PLAN §4.7 |
| S-002 | HR registration delete | User Management "Delete User" archived every employee (anchor counted as history) and app-side cleanup deleted audit logs | Canonical permanent deletion (`20261216100000_identity_permanent_deletion`) + D-006 | commit `f5297467` (2026-10-23); migration header |

## 5. History

| Date | Change |
|---|---|
| 2026-10-25 | **OWN-W3** (owner directive "HR CORE MASTER HANDOVER & WAVE 3 CONTINUOUS DEVELOPMENT", 2026-10-25: "make routine engineering decisions independently and document them"): E-25…E-46 recorded; §3.4 interim defaults with alternatives for PD-ATT-01…08, PD-OT-01…03, PD-LV-01…04 — those PD items stay OPEN. |
| 2026-10-25 | OWN-W2 source added; engineering decisions E-13…E-24 recorded (Wave 1 closure + Wave 2). No PROPOSED/PENDING owner decision changed status. |
| 2026-10-24 | Wave 1 closure: P-R14 assessed NOT REQUIRED (by design, BL-19). |
| 2026-10-24 | Wave 1: E-09…E-12 recorded; P-R14 proposed. |
| 2026-10-24 | OWN-IMPL: OD-B2A-1…7, PD-B2-10, OD-B2B-1…3, PD-GOV-02 decided as D-021…D-032 (rows kept, marked DECIDED); engineering decisions E-01…E-08 recorded; P-R11/P-R12/P-R13 implemented as designed (with E-01…E-05). |
| 2026-10-24 | B0 evidence reconciliation: B0-ENV/B0-PLAN sources added; OD-B2A-1…7 and OD-B2B-1…3 recorded PENDING; interim PD-B2-01…09 SUPERSEDED (S-003, §3.2 mapping); P-R11 source verified; P-R12 (plan's "P-R11") and P-R13 PROPOSED; PD-B2-10, PD-GOV-02 opened. Nothing marked APPROVED. |
| 2026-10-24 | Handover sync (HEAD `1e0830c6`): source OWN-HO added; P-R11 (B2A/B2B split) PROPOSED; PD-B2-01…09 opened with recommended defaults (not approved). B2 plan file missing — its own decision IDs could not be retrieved (BL-8); reconcile when supplied. No status changed to APPROVED. |
| 2026-10-24 | D-020 committed in `8add030c` (owner approval 2026-10-24 11:02); not pushed. |
| 2026-10-24 | PD-GOV-01 decided (D-020); P-G01 superseded; `.gitignore` exception prepared, not committed. |
| 2026-10-24 | Register created from OWN-FIN, OWN-DOC, OWN-REM, migration headers, PMS and the frozen 2026-10-24 assessments. |
