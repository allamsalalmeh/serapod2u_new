# Serapod2U HR — Decision Register

Last verified: 2026-10-24 · HEAD `1e0830c6` (B0 evidence reconciliation) · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

Statuses: **APPROVED** (owner-confirmed or established, documented practice) · **PROPOSED** (recommended in an assessment, not approved) · **PENDING OWNER DECISION** (open question) · **SUPERSEDED** (kept for history).

Rules: rows are never deleted (rule 11). A status change adds a line to §5 History. No approval is recorded without an owner source.

Source abbreviations
- **OWN-FIN** — owner instruction "Cross-Module Finance Integration Architecture Assessment", 2026-10-24 ("The owner has approved the following architecture direction …").
- **OWN-DOC** — owner instruction "HR Master Documentation & Implementation Governance Setup", 2026-10-24 ("Confirmed owner direction includes …").
- **OWN-REM** — owner instruction "HR Remediation Assessment (Continuation)", 2026-10-24 ("Preserve all existing architecture decisions, particularly canonical identity, S&A authorization and controlled Employee Delete/Reset").
- **OWN-HO** — owner instruction "HR Core — New Coder AI Session Handover & Documentation Sync", 2026-10-24 (restates the confirmed attendance decisions; states "No B2 implementation or live migration has been approved by the owner yet").
- **B0-ENV** / **B0-PLAN** — frozen reports [HR_B0_ENVIRONMENT_VERIFICATION.md](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md) and [HR_B0_REVIEW_AND_B2_PLAN.md](assessments/HR_B0_REVIEW_AND_B2_PLAN.md) (HEAD `1e0830c6`, restored and verified 2026-10-24).
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
| **OD-B2A-1** | HR leave authority = explicit **non-legacy** `hr.leave.approve` assignment or Root; legacy-compat-only holders lose leave approval and org-wide leave visibility | 25 staging users are compat-only (BL-11); legitimate approvers need explicit grants first | B2A |
| **OD-B2A-2** | Manager approval requires the `manager-self-service` policy (`hr.mss.leave_approve`/`hr.mss.leave_view`) **and** a verified direct-report relation (`hr_employees.manager_user_id`, active non-archived onboarded manager); no dotted-line managers | New capability for line managers; grants needed | B2A |
| **OD-B2A-3** | Organization-wide HR read of leave uses explicit `hr.leave.approve` until `hr.leave.view` exists (B3/B6) | Leave confidentiality | B2A |
| **OD-B2A-4** | Only explicit HR may cancel approved leave; employees cannot cancel after approval in B2A | Cancellation path | B2A |
| **OD-B2A-5** | Existing self-approved or approver-less rows are **reported** to HR, not altered | Historical records | B2A |
| **OD-B2A-6** | Explicit-HR check: non-legacy assignment on an active membership **in the request's organization or its HQ company** (stricter) vs any active membership (looser, cross-org residual). Confirm whether HQ HR approves for child organizations | HQ→child scope | B2A |
| **OD-B2A-7** | Leave delegation (`hr_delegation_rules`) **not** honoured in B2A (B6 implements it) | Avoids an unreviewed authority path | B2A |
| **OD-B2B-1** | Payroll approval fully blocked (`PAYROLL_STATUTORY_NOT_CERTIFIED`) until statutory certification (Phase B) | Fail-closed payroll | B2B |
| **OD-B2B-2** | OT when policy does not require approval: auto-approve with no approver recorded, **or** always require approval until B5 | Removes requester self-approval | B2B |
| **OD-B2B-3** | Add `npm test -- src/lib/hr` to the **shared** `.github/workflows/ci.yml` | Affects every workstream | B2B |
| PD-B2-10 | **B2A rollback posture** (new at reconciliation; not in B0-PLAN). The plan's rollback restores the previous policies verbatim, which **re-opens SEC-1…3**. Options: (a) full verbatim restore as planned; (b) "safe rollback" — keep the insert/self-approval/visibility restrictions and relax only the authority helper (e.g. temporarily honour compat holders) | Owner asked for rollback that does not reintroduce insecure access | B2A |
| PD-GOV-02 | Version-control the v2 diagnostic: add a narrow `.gitignore` exception for `docs/hr/**/*.sql` (D-020 covers `.md` only), or keep `.sql` evidence untracked | Evidence integrity (BL-13) | Governance |
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

## 4. Superseded decisions

| ID | Topic | Former decision | Superseded by | Date & source |
|---|---|---|---|---|
| S-001 | Archived identifiers | Archive keeps email/phone reserved forever (`20260929160000_identity_stage2_archive_keeps_identifiers`) | D-007 (controlled release) | 2026-10-24 · MIG-20261217100000 header |
| S-003 | B2 decision IDs | Interim PD-B2-01…09 (created 2026-10-24 while B0-PLAN was missing) | OD-B2A-1…7, OD-B2B-1…3 (mapping §3.2) | 2026-10-24 · B0-PLAN §4.7 |
| S-002 | HR registration delete | User Management "Delete User" archived every employee (anchor counted as history) and app-side cleanup deleted audit logs | Canonical permanent deletion (`20261216100000_identity_permanent_deletion`) + D-006 | commit `f5297467` (2026-10-23); migration header |

## 5. History

| Date | Change |
|---|---|
| 2026-10-24 | B0 evidence reconciliation: B0-ENV/B0-PLAN sources added; OD-B2A-1…7 and OD-B2B-1…3 recorded PENDING; interim PD-B2-01…09 SUPERSEDED (S-003, §3.2 mapping); P-R11 source verified; P-R12 (plan's "P-R11") and P-R13 PROPOSED; PD-B2-10, PD-GOV-02 opened. Nothing marked APPROVED. |
| 2026-10-24 | Handover sync (HEAD `1e0830c6`): source OWN-HO added; P-R11 (B2A/B2B split) PROPOSED; PD-B2-01…09 opened with recommended defaults (not approved). B2 plan file missing — its own decision IDs could not be retrieved (BL-8); reconcile when supplied. No status changed to APPROVED. |
| 2026-10-24 | D-020 committed in `8add030c` (owner approval 2026-10-24 11:02); not pushed. |
| 2026-10-24 | PD-GOV-01 decided (D-020); P-G01 superseded; `.gitignore` exception prepared, not committed. |
| 2026-10-24 | Register created from OWN-FIN, OWN-DOC, OWN-REM, migration headers, PMS and the frozen 2026-10-24 assessments. |
