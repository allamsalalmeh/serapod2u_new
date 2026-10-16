# HR Module Assessment (Part K) — Serapod2U

Prepared by: CODER AI · Branch `issues-fixing-oct2` · Read-only assessment (no further code changes).

Scope: the **actual** implemented Serapod2U HR system, not a SAP module wishlist. Evidence from
`app/src/app/hr/**`, `app/src/app/api/hr/**`, `app/src/components/hr/**`,
`app/src/lib/server/hr/**`, `supabase/migrations/*hr*`, `supabase/schemas/current_schema.sql`.

---

## Report A — HR Current State Assessment

Key: ✅ Implemented & verified · 🟡 Partial · 🔴 Problematic · ⚪ Not implemented · ➖ N/A · ❓ Unable to verify

| Capability | Evidence | State |
| --- | --- | --- |
| HR Master Data / Employee Profiles | `hr_employees`, `users`, `/api/hr/employees`, `people/employees` | ✅ |
| Position Management | legacy `hr_positions` (job titles) + **new** `hr_position_slots`/`hr_job_classifications`/relationships/assignments | 🟡 (V1.1 foundation added; D3/D4/D6 UI incomplete) |
| Organizational Management | `departments` hierarchy + `OrgChartTab`; **position** hierarchy now added | 🟡 |
| ESS | `/hr/my-workspace`, self-service APIs, mobile views | ✅ |
| MSS | `manager-self-service` S&A family, `/api/hr/mss/team`, compensation viewer RLS | ✅ |
| Leave Management | `hr_leave_requests`/`hr_leave_types`, leave request/approval flows | ✅ |
| Attendance & Time | `hr_attendance_*`, clock-in-out, timesheets, overtime, shifts | ✅ |
| Compensation | `hr_commission_*`, `hr_employee_compensation`, `hr_employee_allowances` | 🟡 |
| Payroll | `hr/payroll/*` (payslips, salary, runs, statutory) | 🟡 (GL/posting partial) |
| Performance | `hr/performance/*`, KPI module (objectives/reviews/appraisals) | ✅ |
| Reporting & Analytics | `hr/analytics/*`, KPI reports | 🟡 |
| HR Documents | `compliance-docs`, `document-requests`, `hr_compliance_*` | 🟡 |
| Workflow & Approvals | `hr_profile_change_requests`, leave/timesheet/KPI approvals, **new** position change requests | ✅ |
| Security & Access | `sa_permissions`/`sa_business_roles`, `authorizeOperation`, `hrCan`, RLS | ✅ |
| Employee Lifecycle | onboarding state, recruitment (jobs/applicants/interviews/offers) | 🟡 |
| Onboarding / Offboarding | `hr/onboarding/*`, `hr_onboarding_state_and_data_reset` | 🟡 (offboarding partial) |

### Architecture gaps (evidence)
1. **Employee vs position reporting split** — `users.manager_user_id` (employee→employee) drives
   MSS/leave/attendance, while the new `hr_position_relationships` is position→position. No
   reconciliation yet, so an employee's manager and their position's parent can diverge. (Part G
   designed, not fully wired.)
2. **No position effective-dating before this change** — assignment/version history is new and
   unpopulated; backfill is manual.
3. **S&A ↔ position model** — no position-derived roles (correct), but additional-manager scoped
   visibility is API-only, not RLS.

---

## Report B — SAP SuccessFactors Gap Analysis (matrix)

| Area | Serapod (current) | SAP EC reference | Gap | Priority |
| --- | --- | --- | --- | --- |
| Position Management | Slot model (new, partial UI) | Position + Position Matrix | Detail UI, bulk import, matrix relationship UI | P0 |
| Employee master | `users`/`hr_employees` current-state | Effective-dated employment | No employment effective dating | P1 |
| Reporting relationships | Employee manager + new position relationships | Position relationships (typed, dated) | Reconcile employee↔position | P1 |
| Job classification | New `hr_job_classifications` | Job Classification / Job Function | Grade bands, families config | P2 |
| Org structure | Department + position trees | Org Unit + Position hierarchy | Multi-root position chart UI | P0 |
| ESS/MSS | Both present | ESS/MSS | Scoped manager visibility RLS | P1 |
| Compensation/Payroll | Partial | Compensation + Payroll | GL posting completeness, statutory (EPF/SOCSO/PCB) | P1 |
| Performance | KPIs/appraisals/reviews | Performance Management | Calibration, succession | P2 |
| Reporting | Analytics + KPI | Report Center | HR headcount/compliance reports | P2 |

Standard vs organization-specific: multi-root co-equal MDs and Malaysia statutory are
**organization-specific**; slot-based positions, effective dating, and typed relationships are
**standard EC**.


## Report C — Recommended HR Development Roadmap

| # | Phase | Objective | Gaps solved | Scope | SAP ref | Deps | Order | Complexity | Priority | Risks | SQL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Position Management completion | Production-ready position UI | D3/D4/D6 + matrix UI | Detail panel, drag-drop→change request, bulk import, org chart wiring | EC Position Management | foundation (done) | 1 | M | **P0** | UI scope creep | Yes |
| 2 | Reporting-line reconciliation | Single source of truth | Employee↔position divergence | Recalc job: sync `users.manager_user_id` from active PRIMARY incumbents | EC Reporting Relationships | Phase 1 | 2 | M | **P0** | Payroll/MSS data shift | Yes |
| 3 | Scoped manager visibility (RLS) | DB-layer least privilege | API-only scoping | RLS predicates for additional managers | EC RBP | Phase 2 | 3 | M | **P1** | Over-exposure regression | Yes |
| 4 | Employment effective dating | History for employee records | No dated employee facts | `hr_employee_versions` + as-of queries | EC Employee Central | Phase 2 | 4 | L | P1 | Data migration | Yes |
| 5 | Payroll statutory completion | Malaysia compliance | EPF/SOCSO/PCB depth | Statutory tables + posting | EC Payroll | — | 5 | L | P1 | Regulatory | Yes |
| 6 | Performance calibration/succession | Talent depth | Reviews lack calibration | Calibration sessions, succession | EC Performance & Succession | Phase 4 | 6 | L | P2 | Low demand | Yes |

**Do not build** everything SAP has: skip Position Matrix advanced rules, complex RBP inheritance,
and full Payroll Control Center until P0/P1 land.

---

## Report D — HR Go-Live Readiness

| Dimension | Readiness | Blocker / evidence |
| --- | --- | --- |
| Master data quality | Not ready | Position slots unpopulated; reconciliation backfill not run; no dedupe run |
| ESS/MSS readiness | Ready with conditions | Both functional; scoped visibility still API-only |
| Security | Ready with conditions | S&A solid; position additional-manager RLS pending |
| Approval governance | Ready with conditions | Position workflow added but not UAT'd; approver resolution role-based |
| Employee reporting | Not ready | Employee↔position reconciliation not implemented |
| Payroll dependencies | Not ready | Statutory depth + GL posting not verified for production |
| Auditability | Ready with conditions | Position audit table added; legacy modules vary |
| HR administration | Ready with conditions | Position admin UI partial (no detail/bulk) |
| UAT coverage | Not ready | 22 mandated scenarios not all exercised (pure-logic tests only) |
| Operational support | Unable to verify | No runbook for new tables; migration manual |

**Critical blockers:** (1) reconciliation backfill not run; (2) employee↔position reporting
divergence; (3) scoped-visibility RLS gap; (4) payroll statutory verification.

---

## Report E — Recommended Next Phase

**Phase 1 — Position Management completion (P0).**

Why first: the foundation (tables, APIs, domain logic, tests) is already in place, so this is the
lowest-risk, highest-value next step. It converts the position-centric model from "foundation" to
"operational" by closing the UI gaps (detail panel, drag-and-drop → change request, bulk import,
and wiring the position org chart into the admin chart) and unlocks everything downstream
(reconciliation, scoped visibility, effective dating). It does **not** require re-architecting
security or payroll, and it unblocks the other two P0 items.

Acceptance criteria: full position detail view; bulk import with dry-run + duplicate detection;
matrix/second-manager relationship UI; multi-root position chart renders two co-equal MDs with no
dummy CEO; 22 UAT scenarios exercised; requires one SQL migration (import/audit support).
