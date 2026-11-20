# HR Core — Finance-Ready Implementation Roadmap

Branch `Enhancement03` @ `82da8cd0` · 2026-10-24 · **proposal only — awaiting owner approval; nothing implemented.**

Direction (owner-approved): **HR Core first, Finance-ready from day one; Payroll and Finance go live separately; one Shared Finance Integration Framework.**

This roadmap layers on top of the HR remediation sequence (P0–P7 in `HR_IMPLEMENTATION_SEQUENCE.md`, previous session). Cross-references are given as "HR-Px".

---

## 1. Architecture findings (verified) — short form

1. A working GL, fiscal periods, reports and bank-statement maker-checker exist; AP/AR are read-only views over supply-chain documents; no cost centres, dimensions or journal currency.
2. Eleven functions write journals; three idempotency stores; period lock enforced by one writer; reversal uses legacy `is_hq_admin()`; GL tables are insertable directly by `finance.journal.post` holders.
3. Two HR GL mapping models; Model 1 (`payroll_components` / `payroll_component_gl_map`, company-scoped) is the canonical candidate and already referenced by the commission outbox.
4. Payroll maker-checker is already enforced in the database (`sa_payroll_run_transition_guard`), and a schema-correct `compute_payroll_item()` exists unused — corrections to the previous HR reports.
5. Proven reusable patterns: `gl_document_postings`, `post_document_to_gl` core, `get_posting_preview`, `notifications_outbox` + cron lease worker, commission transfer outbox, controlled-action (`request_id`, preview token, append-only record).

## 2. Recommended architecture (summary)

Transactional outbox in the same database: source finalisation → `finance_submit_posting_request` → Finance acceptance (SoD) → single posting function → `gl_journals` + `gl_document_postings`; asynchronous worker with retry/dead-letter for technical failures; daily reconciliation view. Sources never send GL accounts; Finance maps semantic posting keys (payroll component codes) to accounts with effective dating. Details: `SHARED_FINANCE_INTEGRATION_CONTRACT_V1.md`, `FINANCE_POSTING_GOVERNANCE_DESIGN.md`.

---

## 3. Phase A — HR Core Minimum Finance Readiness (before HR Core go-live)

Principle: capture data that **cannot be reconstructed later**; build nothing that posts.

| # | Item | Why now | Affected areas | Migration | Folded into |
|---|---|---|---|---|---|
| A1 | `hr_employee_versions` (effective-dated department, position, manager, employment type, status, work state) **with a nullable `cost_centre_ref` slot** | Historical cost allocation is impossible to rebuild | `hr_employees` trigger, employee APIs | yes | HR-P5c (pull forward) |
| A2 | Compensation non-overlap constraint + change log (actor, reason, effective date) | Payroll history integrity | `hr_employee_compensation`, payroll compensation API | yes | HR-P5c |
| A3 | Allowance/deduction **type → payroll component** link (by `payroll_components.code`), decided by Finance-owned component catalogue | Avoids guessing mappings for historical pay items | `hr_allowance_types`, `hr_deduction_types`, components API | yes (FK/code column) | new |
| A4 | Statutory employee profile capture (DOB, residency/citizenship, NRIC/passport, EPF/SOCSO/tax refs, marital/children) with column grants | Needed for Payroll B; capture during onboarding | onboarding, profile, ESS change requests | yes | HR-P5c |
| A5 | Leave ledger (days only, no money) with `is_unpaid` type flag and `encashment` entry type | Unpaid leave & encashment & liability later read it | leave design | yes | HR-P4 |
| A6 | Separation data: last working date, separation reason; archive must not force `current_date`; end compensation/assignments on end date | Final pay & leaver exclusion | lifecycle | yes | HR-P5b |
| A7 | Status vocabulary for every HR financial source: `approved`/`locked` + immutable after lock (OT requests, timesheets, expense claims, commission already) | Contract requires final states | attendance, OT, expense | small | HR-P2/P4 |
| A8 | Containment from HR-P2 (leave RLS guard, payroll fail-closed, disable `/api/hr/finance/post-payroll-run`) | Prevent bad financial data from being created | — | 1 small | HR-P2 |

Explicitly **not** in Phase A: posting requests, Finance acceptance, cost-centre master, statutory engine, component-level payroll table, any GL change.

Acceptance: every employee change creates a version row; no overlapping compensation; every allowance/deduction type has a component code; statutory profile capturable with correct column grants; leave ledger in place; archive records last working date and ends compensation.

## 4. Phase B — Payroll Integration Preparation (before Payroll go-live)

| # | Item | Affected | Notes |
|---|---|---|---|
| B1 | Payroll calculation rebuilt in the database starting from `compute_payroll_item()` | calc/approve routes, new DB functions | HR-P6b; statutory per HR-P6a |
| B2 | `hr_payroll_run_item_components` (component code, amount, quantity, department/cost-centre snapshot, statutory wage flags used) | payroll | Foundation of posting lines |
| B3 | Run type (`regular`, `off_cycle`, `final`) and run revision; immutability trigger on items after approval | payroll | Correction = reversal + revision |
| B4 | Consumption markers: timesheets/OT requests/commission transfers stamped with the consuming run | attendance, OT, commission | Prevents double pay |
| B5 | Commission transfers imported as `COMMISSION` component lines; transfer `gl_journal_id` left unused | commission | Single expense path |
| B6 | Canonical payroll GL path decision executed: route `/api/hr/finance/post-payroll-run` → 410, revoke `hr_post_payroll_run_to_gl`, `hr_post_payroll_payment_to_gl`, `hr_post_statutory_payment_to_gl` execute; reconcile any journals they created | GL routes | Owner decision D3 |
| B7 | `post_payroll_run_to_gl`: filter component map by effective date; revision-aware posting key; reversal period check + S&A key | Finance functions | Minimal changes, keeps it usable if Payroll goes live before the shared framework |
| B8 | Payroll status `approved → awaiting_finance` visible when Finance integration is off; payroll payment batches and statutory remittance schedules produced as **documents** (no journals) | payroll | Finance-independent go-live |

Decision point: if Payroll goes live **before** Phase C, it posts with the canonical `post_payroll_run_to_gl` (manual, S&A-gated, period-checked) — this is the bridge. If Finance is not used at go-live, payroll stops at `awaiting_finance`; nothing is lost because the run and its components are the durable source.

## 5. Phase C — Shared Finance Integration (when Finance is ready)

| # | Item |
|---|---|
| C1 | `finance_posting_requests`, `_lines`, `finance_posting_events` (append-only), contract v1 functions (submit, preview, accept, reject, post, reverse) |
| C2 | Finance posting worker (copy of notification-outbox worker + `cron_worker_leases`), retry/dead-letter, reconciliation view |
| C3 | GL hardening: posted-journal immutability, remove direct GL insert RLS, single period-check enforcement point, source-derived company, journal currency columns |
| C4 | Cost-centre master (Finance) + effective-dated department → cost-centre mapping (HR maintains); dimension catalogue |
| C5 | Payroll becomes contract source #1: approval → submit in the same transaction; canonical function wrapped by `finance_post_request` |
| C6 | Finance UI: posting queue, accept/reject/retry, reconciliation, dead-letter; new keys `finance.journal.reverse`, period close |
| C7 | SoD rules from the governance design; LEGACY_RETIRED from birth |
| C8 | Leave liability report (ledger × daily rate) — reporting only |

## 6. Phase D — Wider Cross-Module Adoption

| # | Source | Approach |
|---|---|---|
| D1 | Supply-chain documents (5 posting types) | Re-implement `v_pending_gl_postings`/auto-post triggers as contract submissions; keep `get_posting_preview` rules as the mapping for those posting keys; retire `batch_post_documents`, `post_customer_receipt_to_gl` |
| D2 | HR expenses & benefits | Replace `hr_post_expense_*`, `hr_post_benefit_contribution_run_to_gl` and `hr_gl_mappings` with contract submissions |
| D3 | E-commerce storefront (Stripe) | Paid order → revenue/receivable/fees; shipping cost & subsidy |
| D4 | Marketplace settlements & payouts | `marketplace_settlements` (revenue, fees, refunds, currency, `dedupe_key`) → contract; payouts → bank clearing |
| D5 | Inventory valuation | `stock_movements.unit_cost/total_cost` → inventory/COGS (requires costing policy decision) |
| D6 | AP/AR subledgers | Only if business needs independent vendor bills/customer invoices beyond order documents |

## 7. What can be deferred without future migration problems

| Deferrable | Condition that keeps it safe |
|---|---|
| Entire posting framework (Phase C) | Sources keep immutable approved records with stable ids and component detail (A + B) |
| Cost-centre master | Employment versions carry department and a nullable cost-centre slot now (A1) |
| Statutory engine | Statutory profile captured from onboarding (A4); payroll not live |
| Journal currency | No non-MYR source posts before C3 |
| Leave liability | Ledger stores days by type and date (A5) |
| Supply-chain migration to contract | Existing pull model keeps working; it already uses `gl_document_postings` |
| Removing Model 2 tables | Revoke execute instead of dropping; drop later |

**Not deferrable** (would create data migration or architecture problems): A1, A2, A3, A5, A6, B2 design, the canonical-path decision (D3 below).

## 8. Decisions requiring owner approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | One HQ organization = one legal entity/ledger for V1 | Yes; explicit legal-entity record in Phase C |
| D2 | Cost centre = Finance master, separate from departments; HR maintains mapping | Yes |
| D3 | Canonical payroll GL path = `post_payroll_run_to_gl` family (Model 1); retire `hr_post_payroll_run_to_gl` + `hr_gl_mappings` for payroll | Yes (execute in Phase B) |
| D4 | Transport = in-database transactional outbox + cron worker (no broker, no internal REST) | Yes |
| D5 | Sources send semantic posting keys, never GL accounts | Yes |
| D6 | Payroll posting always requires manual Finance acceptance in V1 | Yes |
| D7 | `hr.payroll.release` means "submit to Finance"; journal writing needs Finance keys | Yes (S&A change — separate approval) |
| D8 | Payroll may go live before Finance using the bridge (B7) or stop at `awaiting_finance` | Owner choice |
| D9 | Pull A1/A2/A4 (from HR-P5c) forward into HR Core go-live scope | Yes |
| D10 | Commission expense recognised only via payroll (transfer `gl_journal_id` stays unused) | Yes |

## 9. Proposed implementation sequence

```
HR-P0 ─▶ HR-P1 ─▶ HR-P2 (=A8) ─▶ HR-P3 ─▶ HR-P4 (+A5, A7) ─▶ HR-P5 (+A1, A2, A4, A6 pulled forward) + A3
                                                               │
                                       ── HR Core go-live (Phase A complete) ──
                                                               ▼
                                     Phase B (B1–B8; with HR-P6) ── Payroll go-live (bridge or awaiting_finance)
                                                               ▼
                                     Phase C (C1–C8) ── Finance integration go-live
                                                               ▼
                                     Phase D (D1 → D2 → D4/D3 → D5 → D6)
```

Each phase follows the same delivery rules as the HR remediation sequence: migrations stamped after `20261218100000`, replica tests, owner-applied staging-first, rollback documented, no S&A change without separate approval.

Nothing has been implemented. Awaiting owner review and approval.
