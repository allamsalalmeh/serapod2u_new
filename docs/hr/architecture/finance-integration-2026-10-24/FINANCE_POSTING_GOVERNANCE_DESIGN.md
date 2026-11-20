# Finance Posting Governance Design

Branch `Enhancement03` @ `82da8cd0` · design proposal · 2026-10-24. **[F]** fact · **[R]** recommendation. No pathway is removed or modified by this document.

---

## 1. Governance chain

```
Source module                        Finance                                   GL
─────────────                        ───────                                   ──
prepare (maker)  ─┐
approve (checker)─┤ source SoD (existing)                                      
lock / finalise  ─┘──submit (same txn)──▶ posting request ──validate──▶ ready
                                          accept (Finance user, SoD vs source) ──▶ post ──▶ gl_journals + gl_document_postings
                                          reject (reason) ──▶ source issues revision
                                          reverse (reason, open period) ──▶ reversal journal + reversal request
```

| Control | Mechanism | Reuses [F] |
|---|---|---|
| Source approval | Source workflow (payroll `prepare→approve`, commission `approve→lock`) | `sa_payroll_run_transition_guard`, commission SoD |
| Finance acceptance | `finance_accept_posting` — explicit S&A key, actor ≠ source preparer **and** ≠ source approver | `sa_enforce_same_document_sod` |
| Journal posting | Single Finance function; no other function may insert `gl_journals` (Phase C hardening) | `post_document_to_gl` core |
| Duplicate prevention | `gl_document_postings` unique key on `(company_id, document_type, document_id[:revision])` + request `idempotency_key` unique + row lock on request | existing constraint |
| Period lock | `is_posting_date_allowed(date, company)` in post **and** reverse; locked years refuse | existing function |
| Reversal / correction | Reversal journal (never delete/update posted lines) + source revision for re-posting | `reverse_gl_journal` (to be S&A-guarded) |
| Audit | Append-only `finance_posting_events` (submit/validate/accept/reject/post/fail/retry/reverse, actor, before/after status) + S&A decision log + System Logs for worker | `bank_statement_events` pattern |
| Cross-organization isolation | Company resolved from **source record**; actor must hold the key in that company's scope; RLS on request tables by `company_id` | `sa_require_operation` with resource org |

## 2. Separation of duties (proposed SoD rules)

Existing [F]: `payroll-prepare-approve` (enforce), `payroll-prepare-release` (monitor), `payment-request-maker-checker` (enforce), `bank-statement-maker-checker` (enforce).

| New rule [R] | Kind | Left | Right | Enforcement |
|---|---|---|---|---|
| `payroll-approve-finance-accept` | same_document | `hr.payroll.approve` | `finance.payroll_integration.manage` (accept) | enforce |
| `payroll-prepare-finance-accept` | same_document | `hr.payroll.prepare` | `finance.payroll_integration.manage` | enforce |
| `posting-accept-vs-reverse` | same_document | posting accept | reversal | monitor (small teams) |
| `hr-compensation-vs-finance-post` | permission_conflict | `hr.compensation.manage` | `finance.journal.post` | monitor |

Small-company reality: mitigations through the existing `sa_sod_mitigations` (granted by a security administrator, never self) instead of disabling rules.

## 3. Permissions [R]

| Action | Key | Notes |
|---|---|---|
| View posting queue | `finance.ledger.view` | Payroll requests show aggregates only |
| Accept/post payroll requests | `finance.payroll_integration.manage` (existing) | Replaces using `hr.payroll.release` for the GL step |
| Accept/post other modules | `finance.journal.post` (existing) | |
| Reverse | **new** `finance.journal.reverse` | Today `reverse_gl_journal` uses legacy `is_hq_admin()` |
| Close/lock periods | `finance.settings.manage` (existing) or **new** `finance.period.close` | `close_fiscal_period()` has no internal check today |
| Retry / dead-letter handling | `finance.journal.post` | |
| Source submit | none for humans — called inside source finalisation functions (`service_role` execute only) | Prevents privilege escalation through internal APIs |

`hr.payroll.release` becomes "release approved payroll to Finance" (submit), not "write journals". This is the key HR ↔ Finance separation.

## 4. Payroll confidentiality

- Posting requests carry **aggregated** payroll lines (component × department × cost centre). Employee-level lines only for net-pay sub-ledger/payment files, visible to `finance.payroll_integration.manage` holders, never to `finance.ledger.view`.
- `gl_journal_lines.entity_type/entity_id` must not carry `employee` for accrual lines.
- Drill-back from GL to payroll goes through HR APIs and their existing RLS (`sa_hr_self_or_manager_read` on run items) — Finance never reads salary tables directly.

## 5. Payroll-to-GL path reconciliation (Step 8)

| Aspect [F] | `post_payroll_run_to_gl(run, posting_date)` | `hr_post_payroll_run_to_gl(run, amount)` |
|---|---|---|
| Consumers | `/api/hr/payroll/post-to-gl` POST (UI: `HrPayrollPayslipsView`), reversal via DELETE → `reverse_payroll_gl_posting` | `/api/hr/finance/post-payroll-run` (no UI caller) |
| Security | `SECURITY DEFINER`; `sa_require_operation('hr.payroll.release', run.organization)`; legacy `sa_assert_staff_actor(20)` while not NEW | invoker; `sa_require_operation('hr.payroll.release')`; effective rights also need `gl_journals` INSERT RLS (`finance.journal.post`) |
| Status precondition | `approved` or `finalized` | `approved` |
| Company | `get_company_id(run.organization_id)` (source-derived ✓) | `get_company_id(run.organization_id)` ✓ |
| Period check | `is_posting_date_allowed` ✓ | ✗ |
| Mapping | `payroll_components` × `payroll_component_gl_map` (company; effective dates present but **not filtered**) + `payroll_clearing_accounts` auto-balance line | `hr_gl_mappings` (organization; mapping keys salary_expense, payroll_payable, epf/socso/eis/pcb payable, employer expense) |
| Granularity | One `payroll_journals` row per component, then journal lines | Fixed aggregate lines |
| Balancing | Clearing account auto-balance (explicit line) | **"force balance"**: `v_total_debit := v_total_credit` when employer-expense account missing — header can disagree with lines |
| Journal | `gl_journals.journal_type='PAYROLL'`, status POSTED, created/posted by actor | `journal_type='PAYROLL_RUN'`, POSTED, no created_by/posted_by |
| Idempotency | `hr_payroll_runs.gl_status='POSTED'` check + `gl_document_postings` insert | `hr_gl_postings` row check |
| Run update | sets `gl_journal_id`, `gl_status`, `gl_posted_at`; writes `hr_payroll_audit` (correct columns) | none on the run |
| Reversal | `reverse_payroll_gl_posting` → `reverse_gl_journal` (legacy HQ check, no period check) → run `gl_status='REVERSED'`, posting `REVERSED` | none |
| Re-post after reversal | blocked by unique `gl_document_postings` row (and `payroll_journals` not cleared) | n/a |
| Sibling | `post_payroll_payment_to_gl` (payment batches → clearing/bank; no app caller) | `hr_post_payroll_payment_to_gl` (no guard, no caller) |
| Cross-awareness | does not read `hr_gl_postings` | does not read `gl_status`/`gl_document_postings` → **double-post possible** |

**Recommendation [R]: canonical = `post_payroll_run_to_gl` + `reverse_payroll_gl_posting` + `post_payroll_payment_to_gl` (Model 1).** Reasons: Finance-shaped company mapping, effective-dated component map (just needs the date filter), period check, shared idempotency ledger used by supply chain, existing UI, reversal, explicit balancing line, correct audit columns, commission already speaks its component codes.

Not now (owner decision, Phase B): disable the other path by revoking execute and returning 410 from its route; reconcile any journal it created (`hr_gl_postings` where `document_type='PAYROLL_RUN'`). Phase C: wrap the canonical function behind `finance_post_request` so payroll becomes one source of the shared contract; fix effective-date filter, revision-aware posting key, period check on reversal, S&A key on reversal.

## 6. Hardening the GL itself (Phase C)

1. Append-only guard on `gl_journals`/`gl_journal_lines` once status ≠ DRAFT (trigger raising on UPDATE/DELETE except the status transition POSTED→REVERSED performed by the reversal function).
2. Remove direct INSERT RLS on `gl_journals`, `gl_journal_lines`, `gl_document_postings` for `authenticated`; only definer posting functions write.
3. Period check in every writer (or a BEFORE INSERT trigger on `gl_journals` calling `is_posting_date_allowed(posting_date, company_id)` — single enforcement point).
4. Company always from source; assert `company_id` is an HQ organization.
5. Currency columns on journals (base + document currency, rate) before any non-MYR source (marketplace) posts.
6. Retire or guard the unguarded writers (`hr_post_payroll_payment_to_gl`, `hr_post_statutory_payment_to_gl`, `hr_post_expense_reimbursement_to_gl`, `close_fiscal_period`) — revoke execute; replace with contract submissions.
7. `finance.data.reset` must be impossible once a company is "Finance live" (mirror `hr_go_live_state`).

## 7. Security requirements checklist (Step 9)

| Requirement | Design element |
|---|---|
| Canonical S&A authorization | Every human action through `sa_require_operation` with the **source record's** organization; no legacy fallbacks (`is_hq_admin`, `sa_assert_staff_actor`) in new code |
| Organization / legal-entity boundaries | Company derived from source; RLS on request tables by `company_id`; cross-company requests refused |
| Explicit Finance posting permissions | `finance.payroll_integration.manage`, `finance.journal.post`, new `finance.journal.reverse`, period close key; none in legacy compat policies; LEGACY_RETIRED from birth |
| Payroll confidentiality | Aggregated lines; employee detail stays in HR behind existing RLS/column grants |
| HR vs Finance SoD | §2 rules; `hr.payroll.release` no longer writes journals |
| No privilege escalation through internal APIs | Submit functions executable only by `service_role` and called only from source finalisation functions that already authorized the actor; no generic "post anything" API; source cannot supply GL accounts |
| Service-to-service authentication | None needed (single database). Cron worker authenticates with the existing cron secret and runs as `service_role`; acts only on `accepted`/`auto` requests |
| Auditable financial actions | `finance_posting_events` append-only; S&A decision log; System Logs for worker; source audit (`hr_payroll_audit`) |
