# HR → Finance Readiness Gap Analysis

Branch `Enhancement03` @ `82da8cd0` · read-only · 2026-10-24. **[F]** fact · **[R]** recommendation.
Readiness scale: **Ready** · **Ready w/ gaps** · **Not ready** · **Must never post**.

Rule applied throughout: ordinary operational records (attendance, timesheets, leave applications, OT requests) never post to Finance. Only an **approved, locked financial result** (payroll run, payment batch, statutory remittance, final pay, approved expense claim, commission transfer once paid through payroll) becomes a posting request.

---

## 1. Summary

| Area | Authoritative source [F] | Finance role | Readiness |
|---|---|---|---|
| Employee master | `users` (identity), `hr_employees` (employment, `employee_no`) | Party reference | Ready w/ gaps |
| Effective-dated employment & cost allocation | — (current-state only) | Dimension source | **Not ready** |
| Attendance & timesheets | `hr_attendance_entries`, `hr_timesheets` (status CHECK: draft/submitted/approved/…) | None (payroll input only) | **Must never post** — ready as input |
| Overtime | `hr_overtime_requests` (approver, day_type, rate_multiplier) | None (payroll input) | **Must never post**; input not ready (API column drift) |
| Leave | `hr_leave_*` | None directly; unpaid days & encashment via payroll | Not ready |
| Salary & compensation | `hr_employee_compensation` | Payroll input | Ready w/ gaps |
| Allowances & deductions | `hr_allowance_types/_deduction_types`, employee rows | Payroll input → components | Not ready (no component link / wage flags) |
| Commission | `hr_commission_*`, `hr_commission_payroll_transfers` | Via payroll | **Ready w/ gaps (best in HR)** |
| Offboarding & final pay | `identity_archive_execute` sets status/end_date | Final-pay document | Not ready |
| Payroll calculation | route handler (broken) / `compute_payroll_item` (unused) | Produces the financial document | **Not ready** |
| Payroll approval & locking | `hr_payroll_runs` status, `is_locked`, SoD trigger | Source final state | Ready w/ gaps |
| Payroll → GL | `post_payroll_run_to_gl` / `hr_post_payroll_run_to_gl` | Posting | Not ready (two paths) |

## 2. Area detail

### 2.1 Employee master
1. **Tables/APIs [F]:** `users`, `hr_employees`; `/api/hr/employees*`, `/api/identity/{archive,permanent-delete}`.
2. **Source of truth:** identity = `users.id` (immutable UUID); employment = `hr_employees` (organization, department, position, manager, type, status, hire/end date, `employee_no`).
3. **Finance needs:** stable party id, employee number, legal entity, employment status at period, bank details for payment files, statutory identifiers.
4. **Approval state:** onboarding `completed` gate exists.
5. **Finance-ready?** IDs yes. Statutory identifiers and bank verification no.
6. **Missing:** employer legal entity link (implicit via HQ), statutory profile (EPF/SOCSO/tax numbers, residency), payee bank verification status.
7. **Future integration:** Finance references `users.id` + `employee_no`; never copies personal data into GL.
8. **Risks:** permanent deletion is blocked by history — good; archive keeps UUID — good. None for posting.

### 2.2 Effective-dated employment and cost allocation
1. **[F]** `hr_employees` is current-state; position history exists (HR05) but not employment history; departments are org-scoped and editable.
2. **Source:** HR.
3. **Finance needs:** department (and later cost centre / BU) **as of the payroll period**, split allocation if an employee moves mid-period.
4. **Approval:** none.
5. **Not ready.**
6. **Missing:** `hr_employee_versions` (effective-dated), allocation slot (cost centre id nullable), allocation percentages (defer).
7. **Integration:** payroll lines carry `department_id` (+`cost_centre_id` later) from the version effective at period end (or prorated).
8. **Risk:** if payroll reads current department, re-organisations rewrite historical cost allocation. → **Phase A item** (cheap now, expensive later).

### 2.3 Attendance & timesheets
1. **[F]** `hr_attendance_entries`, `hr_timesheets` (+ `/attendance/*`, `get_payroll_ready_work_minutes()`).
2. **Source:** HR attendance.
3. **Finance needs:** none directly.
4. **Approval:** timesheet `approved` exists.
5. **Must never post.** As payroll input: usable once the payroll calc reads correct columns.
6. **Missing:** payroll consumption marker (which run consumed which timesheet) — `get_payroll_ready_work_minutes` already returns `timesheet_ids`, reuse.
7. **Integration:** none.
8. **Risk:** re-consumption of the same timesheet by two runs → Phase B: stamp `consumed_by_run_id`.

### 2.4 Overtime
1. **[F]** `hr_overtime_requests`, `hr_overtime_policies`, `/attendance/overtime*`.
2. **Source:** approved OT request.
3. **Finance needs:** OT amount (via payroll), quantity (hours), day type, cost allocation.
4. **Approval:** status exists; API cannot write (column drift) and allows requester auto-approval.
5. **Must never post** itself; not ready as input.
6. **Missing:** frozen multiplier at approval exists in schema (`rate_multiplier`) — good; consumption marker.
7. **Integration:** payroll component `OT_*` lines with quantity.
8. **Risk:** OT from both timesheets and requests double-counted → choose requests as sole source (prior report).

### 2.5 Leave (entitlements, unpaid leave, encashment)
1. **[F]** `hr_leave_types/requests/approvals/balances`; no ledger; RLS self-approval hole.
2. **Source:** leave (after P4 ledger).
3. **Finance needs:** unpaid days (salary deduction), encashment amount (final pay), optionally **leave liability** valuation (accrual of untaken annual leave) for financial statements.
4. **Approval:** not trustworthy today.
5. **Not ready.**
6. **Missing:** ledger, `is_unpaid`, encashment entries, daily-rate basis.
7. **Integration:** unpaid/encashment flow only through payroll components `UNPAID_LEAVE`, `LEAVE_ENCASHMENT`; leave liability accrual is a **Phase C** Finance report fed by ledger balances × daily rate (no HR posting).
8. **Risk:** if HR designs the ledger without monetary hooks, liability valuation later needs a data migration → keep `quantity` in days + `leave_type_id` + date; no money in the leave ledger (money is payroll's job).

### 2.6 Salary & compensation
1. **[F]** `hr_employee_compensation` (pay_type, basic, hourly, currency, ot_eligible, effective/end dates, status); column grants; MSS viewer.
2. **Source:** HR compensation.
3. **Finance needs:** none directly (via payroll).
4. **Approval:** none (direct edit by `hr.compensation.manage`).
5. **Ready w/ gaps.**
6. **Missing:** non-overlap constraint, change log (who/why), approval for salary changes (optional V1).
7. **Integration:** payroll input only.
8. **Risk:** overlapping active rows → `compute_payroll_item` picks latest; route picks all → double basic.

### 2.7 Allowances & deductions
1. **[F]** types have `code`, `is_taxable` (allowances), `category` (deductions), `currency`; employee rows have effective dates, installments.
2. **Source:** HR.
3. **Finance needs:** each pay item must map to a **payroll component** (GL mapping) and carry statutory wage flags (EPF/SOCSO/EIS/PCB treatment).
4. **Approval:** none.
5. **Not ready.**
6. **Missing:** `payroll_component_id` (or code) on allowance/deduction types; `epf_wage`, `socso_wage`, `eis_wage`, `pcb_class` flags (on the component, not the type, to avoid duplication).
7. **Integration:** type → component → GL map (Finance).
8. **Risk:** without the link, all allowances collapse into one GL line → **Phase A decision** (link) / **Phase B** (flags used by calculation).

### 2.8 Commission
1. **[F]** cycles (`open→calculated→under_review→approved→locked→payroll_ready`), items with snapshots (`employee_no`, `department_id/name`, BU, rule effective dates), payroll transfer outbox (`idempotency_key`, `payroll_component_code='COMMISSION'`, `payroll_run_id/item_id`, `gl_journal_id/reversal`), SoD, company isolation, replica-tested.
2. **Source:** commission module.
3. **Finance needs:** commission expense by BU/department; payable via payroll.
4. **Approval:** locked + payroll_ready.
5. **Ready w/ gaps** — reference design for other HR areas.
6. **Missing:** consumer (payroll import), cost-centre slot.
7. **Integration:** payroll imports transfers as `COMMISSION` component lines; Finance sees commission only inside the payroll accrual request (no separate posting) — avoids double expense.
8. **Risk:** `gl_journal_id` on the transfer invites a direct commission posting path → **[R]** leave it unused; only payroll posts.

### 2.9 Offboarding & final pay
1. **[F]** `identity_archive_execute` sets `resigned/terminated`, `end_date = current_date`; compensation not ended; no final-pay concept.
2. **Source:** HR lifecycle.
3. **Finance needs:** final pay (prorated salary, encashment, notice pay/deductions, statutory), possibly off-cycle payment.
4. **Approval:** none.
5. **Not ready.**
6. **Missing:** last working date, separation reason, final-pay flag/run type (`regular | off_cycle | final`).
7. **Integration:** final pay is a payroll run of type `final` → same posting request type `PAYROLL_RUN` with `run_type`.
8. **Risk:** leavers included in regular runs (prior report P9).

### 2.10 Payroll calculation
1. **[F]** route `runs/[id]/calculate` (column drift, silent failure); `compute_payroll_item()` (schema-correct, unused, simplified statutory); no component-level line detail.
2. **Source:** payroll.
3. **Finance needs:** component-level amounts per employee, aggregatable by component × department; employer contributions; statutory remittance totals per body.
4. **Approval:** run status.
5. **Not ready.**
6. **Missing:** `hr_payroll_run_item_components` (component code, amount, quantity, department snapshot), rate-set references, run type.
7. **Integration:** posting request lines are produced from component rows.
8. **Risk:** column-based run items (`basic_salary`, `epf_employee`…) cannot represent multiple allowance components → component table is the **Phase B** foundation; design it in Phase A so no migration of history is needed.

### 2.11 Payroll approval & locking
1. **[F]** `draft→calculated→approved` (+`finalized` accepted by GL fn), `is_locked`, `locked_at`, `approved_by`; `sa_payroll_run_transition_guard` (prepare/approve keys + SoD enforce); RLS on items (self or HR manager).
2. **Source:** payroll.
3. **Finance needs:** immutable approved run; revision on correction.
4. **Approval:** maker-checker enforced.
5. **Ready w/ gaps.**
6. **Missing:** immutability trigger on items after approval (RLS only), run revision/reversal model, `posted_at` semantics (currently set at approval).
7. **Integration:** approval → `finance_submit_posting_request` in the same transaction (Phase C); until Finance exists, run reaches `approved` and stays `awaiting_finance` (status visible).
8. **Risk:** approve route sets `posted_at/posted_by` → confusing with GL posting; rename semantics later.

### 2.12 Payroll → GL
See `FINANCE_POSTING_GOVERNANCE_DESIGN.md` §5 for the full comparison. Summary: canonical = `post_payroll_run_to_gl` family (Model 1); retire `hr_post_payroll_run_to_gl` + `hr_gl_mappings` for payroll; long-term both are wrapped by the shared contract.

## 3. Gap → phase allocation

| Gap | Phase A (HR Core) | Phase B (Payroll prep) | Phase C (Finance) | Deferrable safely? |
|---|---|---|---|---|
| Employment versions with department (+nullable cost-centre slot) | ✓ | | | **No** — history cannot be reconstructed later |
| Stable ids/numbers & approved/locked statuses on HR financial sources | ✓ | | | No |
| Allowance/deduction type → payroll component link | ✓ (decision + column) | use in calc | | No (cheap now; mapping history later is guesswork) |
| Statutory employee profile | ✓ (data capture) | used | | Partly — capture now, use in B |
| Leave ledger without money | ✓ (with Leave P4) | unpaid/encashment | liability report | No |
| Last working date / separation reason / run type | ✓ | final pay | | No |
| Component-level payroll detail table | design | ✓ | | Yes until payroll go-live |
| Statutory rate sets, calc rebuild | | ✓ | | Yes until payroll go-live |
| Timesheet/OT consumption markers | | ✓ | | Yes |
| Posting request outbox & Finance acceptance | | | ✓ | Yes |
| Cost-centre master & mapping | slot only | | ✓ | Yes (slot in A avoids migration) |
| Currency on journals, dimensions catalogue | | | ✓ | Yes |
| Leave liability valuation | | | ✓ | Yes |
