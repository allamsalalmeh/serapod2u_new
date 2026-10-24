# Serapod2U HR — Decision Register

Last verified: 2026-10-24 · HEAD `5d6c9bcb` · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

Statuses: **APPROVED** (owner-confirmed or established, documented practice) · **PROPOSED** (recommended in an assessment, not approved) · **PENDING OWNER DECISION** (open question) · **SUPERSEDED** (kept for history).

Rules: rows are never deleted (rule 11). A status change adds a line to §5 History. No approval is recorded without an owner source.

Source abbreviations
- **OWN-FIN** — owner instruction "Cross-Module Finance Integration Architecture Assessment", 2026-10-24 ("The owner has approved the following architecture direction …").
- **OWN-DOC** — owner instruction "HR Master Documentation & Implementation Governance Setup", 2026-10-24 ("Confirmed owner direction includes …").
- **OWN-REM** — owner instruction "HR Remediation Assessment (Continuation)", 2026-10-24 ("Preserve all existing architecture decisions, particularly canonical identity, S&A authorization and controlled Employee Delete/Reset").
- **MIG-xxxx** — owner decision recorded in a migration header.
- **PMS** — `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`.
- **REM-…** / **FIN-…** — frozen assessment reports (see index §5.3).

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
| D-020 | Docs version control (resolves PD-GOV-01) | `docs/hr/**/*.md` is exempt from the global `*.md` ignore via one `.gitignore` exception `!/docs/hr/**/*.md`; Markdown elsewhere stays ignored | 2026-10-24 · owner instruction "HR Documentation Git Tracking Fix" | APPROVED — **implemented**; committed `8add030c` (2026-10-24) · pushed: **No** (branch has no upstream) | All `docs/hr` Markdown becomes trackable once staged and committed | Governance |

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
| PD-GOV-01 | Approve `.gitignore` allowlist for `docs/hr/` (P-G01) | Version control of these docs | **Decided → D-020** (2026-10-24). Kept for history. |

## 4. Superseded decisions

| ID | Topic | Former decision | Superseded by | Date & source |
|---|---|---|---|---|
| S-001 | Archived identifiers | Archive keeps email/phone reserved forever (`20260929160000_identity_stage2_archive_keeps_identifiers`) | D-007 (controlled release) | 2026-10-24 · MIG-20261217100000 header |
| S-002 | HR registration delete | User Management "Delete User" archived every employee (anchor counted as history) and app-side cleanup deleted audit logs | Canonical permanent deletion (`20261216100000_identity_permanent_deletion`) + D-006 | commit `f5297467` (2026-10-23); migration header |

## 5. History

| Date | Change |
|---|---|
| 2026-10-24 | D-020 committed in `8add030c` (owner approval 2026-10-24 11:02); not pushed. |
| 2026-10-24 | PD-GOV-01 decided (D-020); P-G01 superseded; `.gitignore` exception prepared, not committed. |
| 2026-10-24 | Register created from OWN-FIN, OWN-DOC, OWN-REM, migration headers, PMS and the frozen 2026-10-24 assessments. |
