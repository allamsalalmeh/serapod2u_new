# Staff Sales Commission — design, controls and deployment

Status: implemented on `issues-fixing-oct2`. Migrations **not applied** to any environment.

## 1. Architecture audit (2026-10-11, staging schema)

| Area | Finding | Consequence |
|---|---|---|
| Approval timestamp | `orders.approved_at` exists. `orders_approve()` and the messaging confirm flow set it to `now()`, and only from `submitted`. Re-approval overwrites it. No durable status history exists: `system_log_events` only started on 2026-10-09 and is purged by retention. | New append-only `order_status_events` ledger records the first approval from now on. Legacy orders use the stored `approved_at`, labelled *recorded*. Orders without a timestamp are flagged and never guessed. |
| Cancellation | Approved orders can be cancelled (OrdersView, API guard). Cancelling keeps `approved_at`. | Commission rechecks status when a cycle is calculated and when it is approved. A cancellation after approval creates a reversal. |
| Sales value | `order_items.line_total` is a generated column, `qty × unit_price`. No discount, tax or shipping exists on a line. | Commissionable value = `line_total`, per line. The order header total is never used. |
| Business Unit | No Business Unit entity exists. Brands are the closest: Cellera = *Cellera Hero* + *Cellera Zero*, plus Ellbow and Sera Outdoor. | New `hr_commission_business_units` table, with an effective-dated brand → BU mapping maintained by HR. Nothing is seeded. |
| Employees | `hr_employees` is the stable identity (it links to `users`, organization and department). | Rates and items reference `hr_employees.id`, never a name or email. Onboarding must be complete. |
| Payroll | `seed_payroll_components` defines the `COMMISSION` earning (GL 6140 debit / 2200 credit). On staging it has not been seeded. `hr_payroll_runs` and `hr_payroll_run_items` exist. | A hand-off outbox (`hr_commission_payroll_transfers`) uses the COMMISSION code and run/item/GL reference columns. Nothing is posted. |
| Security & Access | HR is `LEGACY_RETIRED`, so S&A decides. `sa_require_operation` is a no-op while a key is not authoritative. Standard policies are scoped by org type and grant scope. | A dedicated `hr_commission_allowed()` gate fails closed. In legacy mode only a Super Admin of the same company passes. |
| Executive Dashboard | "Total Revenue" counted `submitted` orders, dropped `warehouse_packed` and `shipped_distributor`, and included H2M purchases. Its percentage changes were hard-coded. | Fixed (§6). |
| Distributor Analytics | The approval rate counted only `approved` and `closed`. | Fixed (§6). |

## 2. Rules

- **Cycle.** Asia/Kuala_Lumpur, boundaries `[start_at, end_at)`, persisted on each cycle. Default: 28th of the previous month 00:00 to the 28th 00:00 (i.e. 28th–27th). Examples: approved 27 Sep → September cycle; 28 Sep 00:00 → October; 29 Oct → November.
- **Contiguity.** A new cycle starts exactly where the previous one ended and ends where the next one starts. A settings change can therefore never create a gap or an overlap; an exclusion constraint backstops this.
- **Eligible sales.** D2H only (enforced by a CHECK constraint; H2M purchases and S2D are never counted). Statuses `approved`, `warehouse_packed`, `shipped_distributor` and `closed`, checked at calculation and again at approval. The first approval must fall inside the cycle.
- **Attribution.** A line belongs to the BU its product's brand maps to on the approval date (MYT). An unmapped brand is flagged and excluded.
- **Formula.** Commission = Σ eligible BU line values × the employee's rate for that BU on the line's approval date ÷ 100. Exact numeric arithmetic, rounded half away from zero to 2 dp per item (employee × BU × rate period). Example: RM 1,607,784.00 × 0.120% = RM 1,929.34.
- **Rates.** `numeric(9,5)` percent, effective-dated, no overlap per employee and BU. A new rate closes the previous open-ended rate the day before it starts. A change takes effect only after another person approves it; the requester and the employee concerned can never approve.
- **No double pay.** Approval claims every order line exactly once (`hr_commission_source_claims` primary key). A line claimed by another cycle is excluded and flagged. Re-approving an order does not move it, because its first approval stays fixed.

## 3. Ledger and workflow

`open → calculated → under_review → approved → locked → payroll_ready`

- **Recalculate** while the cycle is open, calculated or under review. Each run increments `calc_version` and logs a summary in `hr_commission_calc_runs`.
- **Approve** (`hr.commission.approve`) requires:
  - the approver is not the person who calculated or submitted the cycle;
  - the cycle end has passed;
  - review flags are acknowledged;
  - no adjustments are pending;
  - every source order is still eligible and unchanged.
- **Return** moves *under_review* back to *calculated*, or *approved* back to *under_review* before the cycle is locked. It needs a reason.
- **Approved and later cycles are immutable**, enforced by triggers even against definer functions. Frozen: sources, items, flags, runs, totals, boundaries and approval identities. Rate and brand-mapping end dates cannot be moved before a date a final cycle has paid on.
- **Cancellation after approval.** The next calculation of a later open cycle creates one *pending* negative adjustment per paid item and line. It is keyed `reversal:<order_item>:<item>`, so it exists at most once, even after being rejected.
- **Manual adjustments** need a mandatory reason and maker-checker approval. Decided adjustments are immutable.
- **Changed or removed paid lines** (returns, corrections) are flagged for review and never auto-adjusted. They are resolved with a manual adjustment that names the order.
- **Payroll Ready** prepares one `hr_commission_payroll_transfers` row per employee: gross, approved adjustments with details, net, the payroll period, the COMMISSION code and an idempotency key. It creates **no** payroll run, item, payslip or journal.

## 4. Security & Access

| Permission | Purpose |
|---|---|
| `hr.commission.view` | Settings, rates, cycles, ledger, audit |
| `hr.commission.manage` | Business Units, settings, rate requests, calculate, submit, request adjustments |
| `hr.commission.approve` | Decide rates and adjustments, approve, return, lock, Payroll Ready |
| `reporting.commission.view` | Commission Reporting (no rate administration or audit) |
| `reporting.commission.export` | PDF / Excel export (audited) |

- All five are `security_sensitive`, with the compatibility rule **nobody**. Mode is `NEW_ENFORCED` where `hr.compensation.view` is authoritative, otherwise `SHADOW`. In `SHADOW`, the database allows only a Super Admin of the same company.
- Standard policies are assigned to no one and apply to `HQ` and internal accounts only:
  - Commission Administrator: view + manage;
  - Commission Approver: view + approve;
  - Commission Report Viewer: report view + export.
- HR & Payroll Full Access is **not** extended. To extend it deliberately, run the documented `sa_extend_standard_policy` call. Root Access receives these permissions by design.
- API roles cannot write commission tables directly; all writes go through `hr_commission_*` functions.
- Reads are filtered by RLS per company. Employees cannot read anyone's commission, including their own; employee self-service is not implemented.
- Report views, drill-downs, employee views and exports are written to `hr_commission_audit_log`.

## 5. Application

| Surface | Path |
|---|---|
| Employee rates, eligibility, history, approvals | HR → Employees → profile → **Commission** tab (`EmployeeCommissionPanel`) |
| Cycles workflow, Approvals, Business Units & brands, Cycle Settings | HR → Payroll → **Commission Settings** (`/hr/payroll/commission-settings`) |
| Commission Reporting (filters, summary, BU income, department sections, drill-down, PDF/Excel) | Reporting → **Commission** tab |
| API | `/api/hr/commission/{access,reference,business-units,settings,employees/:userId,requests,cycles,cycles/:id,report,report/drilldown,report/export}` |

The screen, PDF and Excel all render one model (`lib/hr/commission/report.ts`) built from the stored ledger, so they cannot disagree.

## 6. Executive Dashboard and Distributor Analytics

The shared definition lives in `lib/reporting/sales-kpi.ts`:

- **Approved Sales:** `approved`, `warehouse_packed`, `shipped_distributor`, `closed`.
- **Pipeline:** `submitted`.
- **Cancelled:** reported separately.
- **H2M:** a purchase, never a sale.

Executive Dashboard changes:
- **Approved Sales Value** (`totalRevenue` is kept as a compatibility alias), Confirmed Orders, units, trend, buyer performance and product mix now cover approved sales only.
- New cards: Order Pipeline Value, Cancelled Orders, H2M Purchases Value.
- The hard-coded percentage changes are removed from the changed cards.
- The Finance tab's figure uses the same statuses and sales order types.
- Reporting dates (SO `order_date`) are unchanged.

Distributor Analytics changes:
- Approval Rate now counts all approved-stage statuses.
- New values for Approved Sales, Pipeline and Cancelled on screen and in the PDF.
- The operational status mix is unchanged.

## 7. Tests

| Suite | Where | Covers |
|---|---|---|
| SQL (disposable PG17 replica of the staging schema + S&A catalogue) | `supabase/tests/hr_commission/run.sh` | All DB-side scenarios: boundaries/MYT, approval-date eligibility, cancelled vs approved, boundary crossing, repeated approvals, multiple BUs, effective-dated rates, mixed-BU orders, precision/rounding, recalculation, locked immutability, cancellation after lock, reversal idempotency, manual adjustments, SoD, RLS/company isolation, legacy-mode fallback, access audit, exactly-once claims, payroll readiness without payroll. Migrations applied twice (idempotent). |
| Vitest | `lib/hr/commission/*.test.ts`, `lib/security-access/commission.test.ts`, `lib/reporting/sales-kpi.test.ts`, `app/api/reporting/stats/route.test.ts`, `distributor-analytics.test.ts`, `route-coverage.test.ts` | TS/SQL lock-step, cycle maths, rounding, report model, PDF/Excel parity, Executive KPI parity, route coverage |

## 8. Known limitations and deferred work

- Legacy approvals: the *recorded* `approved_at` is the latest recorded approval. For current workflows this equals the first approval, because approval is only possible from `submitted` and no workflow reopens orders. This cannot be proven for history and is labelled on every source line.
- Orders approved with no `approved_at` at all are flagged, never placed into a cycle.
- Attribution uses the product's **current** brand when calculating; it is frozen once the cycle is approved. Changing a product's brand before approval changes attribution on recalculation.
- Returns, partial corrections and line edits after approval are flagged, never auto-adjusted.
- Not implemented:
  - Employee self-service view of published commission.
  - Transfer of prepared rows into `hr_payroll_run_items`.
  - Statutory deductions, payslips and GL posting.
  - A payroll run, an approval chain beyond maker-checker, and S2D/H2M commission.
- The dashboard's H2M exclusion and the new cards change headline numbers. Communicate this before release.

## 9. Deployment checklist

### Prerequisites (every environment)

1. Deploy no app build that depends on these migrations before applying them. Without them the commission UI shows "unavailable" and the dashboard fixes still work.
2. Confirm these migrations are already applied:
   - `20261009100000` (standard policy coverage);
   - `20261030100000` (policy org-type eligibility);
   - the S&A Final Wave foundations.
3. Confirm the `btree_gist` extension exists:
   ```sql
   select extname from pg_extension where extname = 'btree_gist';
   ```
4. Take a backup (`pg_dump` of the database) and record the current `sa_permissions` count.

### Order (staging first, then production)

| # | File | Notes |
|---|---|---|
| 0 | `20261101100000_sa_order_view_policy_dependencies.sql` | Already committed (ac7fb9d6); apply first if not yet applied. |
| 1 | `20261102100000_order_status_events.sql` | Starts recording approvals immediately. Apply as early as possible: every approval before it is only *recorded*. |
| 2 | `20261102110000_hr_commission_core.sql` | |
| 3 | `20261102120000_hr_commission_policies.sql` | |

Each file is repeat-safe and has no cross-statement session state. Run them in autocommit, one file at a time.

### Validation after each environment

1. Five commission permissions, all security-sensitive, with their modes:
   ```sql
   select permission_key, mode
   from sa_migration_modes
   where permission_key like '%commission%';
   ```
   Expect 5 rows, `NEW_ENFORCED` where HR is S&A-authoritative.
2. The approval ledger trigger is installed:
   ```sql
   select tgname from pg_trigger where tgname = 'order_status_events_capture';
   ```
3. Approve one test D2H order on staging, then confirm its first approval and its source:
   ```sql
   select * from order_first_approval('<id>');
   ```
   Expect `source = approval_event`.
4. The three policies exist and are unassigned:
   ```sql
   select b.role_key, count(a.*)
   from sa_business_roles b
   left join sa_role_assignments a on a.role_id = b.id
   where b.role_key like 'commission-%'
   group by 1;
   ```
   Expect a count of 0 for each.
5. As an HQ admin without a grant, `/api/hr/commission/access` returns all `false`, and the Reporting Commission tab and HR Commission Settings show no data.
6. Grant Commission Administrator to an HR user and Commission Approver to a different manager, both scoped to HQ.
7. Run the workflow end to end on staging:
   - create BUs and map brands;
   - set eligibility and request rates; the approver approves them;
   - open a cycle and calculate it; check eligible sales against an independent SQL sum of approved D2H lines in the window;
   - submit; the approver approves after the cycle end; lock;
   - export PDF and Excel and compare the totals with the screen.
8. Cancel a paid test order, recalculate the next cycle, and confirm exactly one pending reversal per paid item.
9. Executive Dashboard: Approved Sales Value equals
   ```sql
   select sum(line_total)
   from order_items oi
   join orders o on o.id = oi.order_id
   where o.status in ('approved','warehouse_packed','shipped_distributor','closed')
     and o.order_type <> 'H2M'
     and o.order_date between <range>;
   ```

### Rollback (only while no commission data exists)

1. Drop the `hr_commission_*` / `hr_employee_commission_*` functions and tables.
2. Delete the five permissions' readiness, mode and compat rows, then the permissions and the three roles.
3. Drop the `order_status_events_capture` trigger.

Keep `order_status_events` once it holds data.
