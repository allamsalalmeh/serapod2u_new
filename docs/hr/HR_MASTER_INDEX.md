# Serapod2U HR — Master Index

> **Start here.** Every HR work session (human or AI) reads this file first. It is the single entry point to the HR programme's scope, decisions, roadmap, progress and go-live gates.

| | |
|---|---|
| Last verified repository | `serapod2u_dev` · branch `Enhancement03` · HEAD `5d6c9bcb` ("fix(hr): serialize bulk removal and retry only proven lock conflicts", 2026-10-24 10:53 +08:00, committed by the owner during this setup; app/test/docs-identity only, no migration). Assessments were made at `82da8cd0`; the `82da8cd0..5d6c9bcb` change does not alter any recorded finding. |
| Last verified date | 2026-10-24 (MYT) |
| Working tree at verification | 83–88 modified/untracked paths (owner work in progress) (S&A finalization V2, system logs, payment gateway, identity); none under `docs/hr/` |
| Environment evidence used | `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md` (last updated 2026-10-16) and the 2026-10-16 schema dumps in `supabase/schemas/audit/`. **No live database was queried** for this documentation. |
| Maintained by | Updated after every approved batch (see Governance rules) |

---

## 1. Programme objective

Deliver a production-ready **HR Core** for Serapod2U — employee master and lifecycle, hybrid attendance, overtime approval, leave, ESS/MSS, performance and commission — under **canonical Security & Access (S&A)** authorization, built **Finance-ready from day one** so that Payroll and the future Shared Finance Integration Framework can connect without redesigning HR Core.

Payroll and Finance integration are **separate, later phases** with their own go-lives (decision D-003).

## 2. Current status (summary)

| Item | Status |
|---|---|
| HR Core delivery | **Not go-live ready.** Identity/onboarding, Performance/KPI and Commission are the most complete; Leave, Attendance enhancements, Lifecycle completion and S&A consolidation are open. See [HR_PROGRESS_TRACKER.md](HR_PROGRESS_TRACKER.md). |
| Current approved phase | **Documentation & governance setup only** (this task). **No implementation batch is approved.** |
| Next recommended work | **Batch B0** (environment & migration verification, read-only) together with **Batch B2** (critical leave containment + payroll fail-closed). See [HR_IMPLEMENTATION_ROADMAP.md](HR_IMPLEMENTATION_ROADMAP.md). |
| Payroll | Not go-live ready (calculation cannot write lines; statutory simplified). Future Phase B. |
| Finance integration | Architecture direction approved; framework not designed for build yet. Future Phase C. |

## 3. Current blockers

| # | Blocker | Effect | Owner action |
|---|---|---|---|
| BL-1 | **[Fix prepared 2026-10-24 — not yet committed]** `.gitignore` ignores all `*.md` (line 156, "Markdown files (Keep local only)"). Only four HR docs are tracked (force-added). The master docs and the `assessments/` / `architecture/` copies created on 2026-10-24 are **on disk but not version-controlled**. | `docs/hr/` cannot yet be the version-controlled source of truth | Exception `!/docs/hr/**/*.md` added to `.gitignore` (D-020); `git check-ignore` verified. Remaining: owner-approved staging and commit of `.gitignore` hunk + `docs/hr` files. Commit status: **No** · Push status: **No** |
| BL-2 | Pending lifecycle migrations `20261214100000`, `20261216100000_identity_permanent_deletion`, `20261217100000`, `20261218100000` are not recorded as applied in any environment, while the HR People UI already calls their functions | Delete/Reset/Archive/Bulk Removal fail on databases without them | Batch B0 verification, then owner-applied Batch B1 |
| BL-3 | Leave RLS allows impersonated inserts and self-approval; organization-wide read of leave reasons/balances | Live data-integrity and privacy exposure wherever leave is used | Approve Batch B2 |
| BL-4 | Payroll calculation writes non-existent columns and reports success | False "calculated" runs | Approve Batch B2 (fail-closed) |
| BL-5 | Production HR permission modes last recorded as mostly SHADOW (2026-10-02); legacy evaluators and compatibility policies still decide | S&A not yet the effective authority in production for HR | Batch B0 measurement, Batch B3 |
| BL-6 | Hybrid Attendance requirements are owner-confirmed at direction level only; detailed rules are not documented anywhere in the repository | Attendance batches cannot be finalised | Owner answers to PD-ATT-* in [HR_DECISION_REGISTER.md](HR_DECISION_REGISTER.md) |
| BL-7 | Duplicate migration versions (`20261216100000` ×2; untracked `20261022100000` collides with an applied file) and future-dated stamps (`202612xx`) | Migration ordering risk | Batch B0 / B1 handling (no renaming of applied files) |

## 4. Owner decisions pending (top items)

Full list with IDs: [HR_DECISION_REGISTER.md](HR_DECISION_REGISTER.md) §3.

- PD-ATT-01…08 — Hybrid Attendance rules (channels, auto-validation, exceptions, corrections approver, import format, mobile controls).
- PD-OT-01…03 — Overtime approver, pre-/post-approval, source of OT minutes.
- PD-LV-01…04 — Leave entitlement policy, carry-forward, new leave permission keys.
- PD-LC-01…03 — Offboarding (separation vs archive), manager reassignment, former-employee documents.
- PD-SA-01…02 — New HR permission keys; production SHADOW→enforced waves and compatibility-policy retirement.
- PD-FIN-01…10 — Finance architecture proposals (legal entity, cost centre, canonical payroll GL path, outbox transport, etc.).
- ~~PD-GOV-01~~ — decided as D-020; fix prepared, awaiting commit approval.

## 5. Documentation navigation

### 5.1 Master documents (authoritative, living)

| Document | Purpose | Authoritative for |
|---|---|---|
| [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md) | Entry point, status, blockers, governance | Current status & rules |
| [HR_MASTER_SCOPE.md](HR_MASTER_SCOPE.md) | Complete HR Core scope by workstream | **What is in scope** |
| [HR_DECISION_REGISTER.md](HR_DECISION_REGISTER.md) | Every decision with status and history | **Decisions** |
| [HR_IMPLEMENTATION_ROADMAP.md](HR_IMPLEMENTATION_ROADMAP.md) | Dependency-ordered batches B0–B9 + future phases | **Sequence & batch definitions** (supersedes the sequences inside the point-in-time reports) |
| [HR_PROGRESS_TRACKER.md](HR_PROGRESS_TRACKER.md) | Per-enhancement status with separate evidence fields | **Progress** |
| [HR_GO_LIVE_GATES.md](HR_GO_LIVE_GATES.md) | Measurable go-live gates | **Go-live readiness** |

### 5.2 Existing HR documents (preserved in place, unchanged)

| Document | Date | Role | Note |
|---|---|---|---|
| [HR Gap & Go-Live Readiness Audit.md](HR%20Gap%20%26%20Go-Live%20Readiness%20Audit.md) | 2026-10-23 (HEAD `92022c44`) | Baseline gap audit | Point-in-time. Some findings superseded (see remediation reports). Not tracked by git (BL-1). |
| [HR_MODULE_ASSESSMENT.md](HR_MODULE_ASSESSMENT.md) | ~2026-10-13 | Earlier SAP-gap assessment (branch `issues-fixing-oct2`) | Historical |
| [HR_ONBOARDING_AND_DATA_RESET.md](HR_ONBOARDING_AND_DATA_RESET.md) | 2026-10-22 | **Authoritative design** for onboarding state, HR Data Management reset and controlled Delete/Reset | Tracked |
| [POSITION_MANAGEMENT_V1.1.md](POSITION_MANAGEMENT_V1.1.md) | ~2026-10-13 | **Authoritative design** for position management | Tracked |
| [STAFF_COMMISSION.md](STAFF_COMMISSION.md) | ~2026-10-11 | **Authoritative design** for staff commission | Tracked; its "migrations not applied" line is outdated (status doc records them applied 2026-10-16) |

Related outside `docs/hr/`: `docs/identity/PERMANENT_IDENTITY_DELETION.md`, `docs/identity/IDENTITY_ARCHIVE_AND_IDENTIFIER_RELEASE.md`, `docs/identity/BULK_EMPLOYEE_REMOVAL.md` (authoritative for identity lifecycle); `docs/security/` (S&A); `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md` (authoritative environment record).

### 5.3 Point-in-time assessments (frozen copies — evidence, not living plans)

Copied byte-for-byte on 2026-10-24 from the deliverables of the 2026-10-24 assessment sessions (they had not previously been saved in the repository). **Do not edit**; record corrections in the master documents.

**HR remediation assessment (HEAD `82da8cd0`)** — `assessments/remediation-2026-10-24/`

| File | Content |
|---|---|
| [HR_REMEDIATION_DEPENDENCY_MATRIX.md](assessments/remediation-2026-10-24/HR_REMEDIATION_DEPENDENCY_MATRIX.md) | Migration readiness, baseline cross-check, new findings |
| [HR_SA_CONSOLIDATION_PLAN.md](assessments/remediation-2026-10-24/HR_SA_CONSOLIDATION_PLAN.md) | Legacy permission layers and S&A consolidation strategy |
| [HR_LEAVE_IMPLEMENTATION_DESIGN.md](assessments/remediation-2026-10-24/HR_LEAVE_IMPLEMENTATION_DESIGN.md) | Leave workflow & ledger design |
| [HR_EMPLOYEE_LIFECYCLE_GAP_REVIEW.md](assessments/remediation-2026-10-24/HR_EMPLOYEE_LIFECYCLE_GAP_REVIEW.md) | Lifecycle gaps D1–D10 |
| [HR_PAYROLL_RISK_ASSESSMENT.md](assessments/remediation-2026-10-24/HR_PAYROLL_RISK_ASSESSMENT.md) | Payroll defects, statutory requirements, GL paths |
| [HR_IMPLEMENTATION_SEQUENCE.md](assessments/remediation-2026-10-24/HR_IMPLEMENTATION_SEQUENCE.md) | Remediation phases P0–P7 (superseded as a plan by the master roadmap) |

**Cross-module finance architecture assessment (HEAD `82da8cd0`)** — `architecture/finance-integration-2026-10-24/`

| File | Content |
|---|---|
| [CROSS_MODULE_FINANCE_ARCHITECTURE_AUDIT.md](architecture/finance-integration-2026-10-24/CROSS_MODULE_FINANCE_ARCHITECTURE_AUDIT.md) | Finance module inventory, journal writers, corrections to HR reports |
| [FINANCE_MASTER_DATA_OWNERSHIP_MATRIX.md](architecture/finance-integration-2026-10-24/FINANCE_MASTER_DATA_OWNERSHIP_MATRIX.md) | Master data ownership |
| [SHARED_FINANCE_INTEGRATION_CONTRACT_V1.md](architecture/finance-integration-2026-10-24/SHARED_FINANCE_INTEGRATION_CONTRACT_V1.md) | Proposed contract (not approved for build) |
| [HR_FINANCE_READINESS_GAP_ANALYSIS.md](architecture/finance-integration-2026-10-24/HR_FINANCE_READINESS_GAP_ANALYSIS.md) | HR area-by-area finance readiness |
| [FINANCE_POSTING_GOVERNANCE_DESIGN.md](architecture/finance-integration-2026-10-24/FINANCE_POSTING_GOVERNANCE_DESIGN.md) | Posting governance, payroll GL path comparison |
| [HR_CORE_FINANCE_READY_IMPLEMENTATION_ROADMAP.md](architecture/finance-integration-2026-10-24/HR_CORE_FINANCE_READY_IMPLEMENTATION_ROADMAP.md) | Phases A–D (folded into the master roadmap) |

### 5.4 Known corrections to the frozen reports

| Report statement | Correction | Source |
|---|---|---|
| Baseline audit: "migrations un-applied in any environment" | Onboarding/reset, commission, MSS/compensation, HR01–HR05 recorded applied on staging & production (2026-10-16) | Remediation dependency matrix §2 |
| Payroll risk assessment: payroll approval does not enforce maker ≠ checker | Enforced in DB by `sa_payroll_run_transition_guard` (`payroll-prepare-approve`, ENFORCE since `20261110100000`) | Finance audit §0 |
| Payroll risk assessment: build a new DB calculation function | Schema-correct `compute_payroll_item()` already exists (unused) — reuse as base | Finance audit §0 |
| Payroll risk assessment: `post_payroll_run_to_gl` writes no shared idempotency marker | It writes `gl_document_postings`; double-posting risk with `hr_post_payroll_run_to_gl` still stands | Finance audit §0 |

### 5.5 Unavailable sources

None of the twelve requested reports is missing. **Not available anywhere in the repository:** a written specification of the Hybrid Attendance enhancements (mobile clock-in controls, HR manual attendance, Excel bulk import, exception-based review). These are recorded in scope from the owner's 2026-10-24 instruction only; details are open decisions (BL-6). No content was reconstructed from assumptions.

---

## 6. Permanent working rules (governance)

1. **Read this master index before starting any HR work.**
2. **Check current repository code and the relevant migration evidence** (`PRODUCTION_MIGRATION_STATUS.md`, schema dumps, live read-only checks) before relying on any document.
3. **Review the decisions and dependencies** for the affected workstream in the decision register and roadmap.
4. **Do not assume older audit findings are still accurate**; re-verify against code at the current HEAD.
5. **Do not introduce architecture changes without owner approval**; record proposals as PROPOSED in the decision register.
6. **Implement only explicitly approved batches**; the approval must be recorded in the roadmap (Owner approval status) before work starts.
7. **After every approved implementation, update** the affected scope, decision, roadmap and progress documents, and this index's status, HEAD and date.
8. **Record verified test results and UAT results separately**; automated tests passing never marks a feature complete.
9. **Never mark a migration applied without environment evidence** (status-doc entry with date and method, or a recorded read-only verification).
10. **Maintain traceability** from scope item → decision → batch → tests → UAT → go-live gate (IDs are used across all master documents).
11. **Preserve previous decisions**, including superseded ones, with history; never delete a register row.
12. **Never silently remove agreed HR enhancements from scope**; descoping requires an owner decision recorded in the register.

Additional conventions (from existing practice):
- New migrations are stamped after `20261218100000`, with a unique version, idempotent, prerequisites asserted, rollback in the header, a replica test suite, owner-applied staging-first, and recorded in `PRODUCTION_MIGRATION_STATUS.md` in the same commit.
- Deployment status is never inferred from Git commits. Unknown environment state is **NOT VERIFIED**.
- Frozen assessment copies are never edited; corrections go to §5.4.

## 7. Change log

| Date | HEAD | Change |
|---|---|---|
| 2026-10-24 | `5d6c9bcb` | PD-GOV-01: `.gitignore` exception `!/docs/hr/**/*.md` prepared (uncommitted); BL-1 updated. |
| 2026-10-24 | `82da8cd0` → `5d6c9bcb` | Master documentation structure created (6 master docs + 12 frozen assessment copies). No application, database or S&A change. |
