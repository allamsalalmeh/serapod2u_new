# Shared Finance Integration Contract — V1 (proposal)

Branch `Enhancement03` @ `82da8cd0` · **design proposal only — nothing to be built without owner approval** · 2026-10-24.

**[F]** facts are referenced to the repository; everything else is **[R]** recommendation.

---

## 1. Design choice in one paragraph

Source modules (HR/Payroll first, then Supply Chain, E-Commerce, Commission) **never write journals**. When a business document reaches a final, approved state, the source module writes one **posting request** (header + semantic lines) into a Finance-owned outbox table **in the same database transaction** as its own finalisation. A Finance-owned worker (reusing the existing cron + lease pattern) validates and maps the request to accounts and dimensions, and a single Finance posting function writes `gl_journals`/`gl_journal_lines` and the idempotency record in `gl_document_postings`. Everything runs inside the one Postgres database the stack already uses, so the "transport" is a table plus a security-definer function — no message broker, no service-to-service HTTP.

Why not REST between modules: there is one database and one Next.js deployment; an internal HTTP hop adds a second authentication surface and loses transactional atomicity with the source finalisation. A thin REST/API layer is kept only for **human** actions (accept, post, reject, retry, reverse) and monitoring.

## 2. Reused building blocks [F]

| Need | Existing component |
|---|---|
| Idempotency ledger | `gl_document_postings` unique `(company_id, document_type, document_id)` |
| Journal writer core | `post_document_to_gl` (balance check, `generate_journal_number`, lines, posting record) |
| Preview | `get_posting_preview` pattern |
| Period control | `fiscal_periods` + `is_posting_date_allowed()` |
| Outbox + worker | `notifications_outbox` columns (`status, retry_count, max_retries, next_retry_at, scheduled_for`) + `/api/cron/notification-outbox-worker` + `cron_worker_leases` + System Logs worker report |
| Source outbox precedent | `hr_commission_payroll_transfers` (`idempotency_key`, `transfer_status`, run/item/GL refs) |
| Authorization & SoD | `sa_require_operation`, `sa_enforce_same_document_sod`, SoD mitigations |
| Payroll mapping | `payroll_components` + `payroll_component_gl_map` (Model 1) |

## 3. Contract — header

Proposed table `finance_posting_requests` (Finance-owned; sources insert only through a security-definer submit function).

| Field | Type | Required | Meaning / rule |
|---|---|---|---|
| `id` | uuid | ✓ | Request id |
| `contract_version` | text | ✓ | `'1.0'`; Finance rejects unknown major versions |
| `source_module` | text | ✓ | `hr_payroll`, `hr_commission`, `hr_expense`, `supply_chain`, `ecommerce`, `marketplace`, `inventory` |
| `source_document_type` | text | ✓ | e.g. `PAYROLL_RUN`, `PAYROLL_PAYMENT`, `STATUTORY_REMITTANCE`, `FINAL_PAY`, `COMMISSION_CYCLE`, `SALES_INVOICE` |
| `source_document_id` | uuid | ✓ | Immutable id of the source record |
| `source_document_revision` | int | ✓ | Starts 1; a correction after reversal is revision 2 (allows re-posting without breaking `gl_document_postings` uniqueness — the posting key is `type + id + revision`) |
| `source_document_number` | text | ✓ | Human reference (run number, doc no.) |
| `idempotency_key` | text unique | ✓ | `source_module:type:id:revision:purpose` |
| `purpose` | text | ✓ | `accrual`, `payment`, `remittance`, `reversal`, `adjustment` |
| `reverses_request_id` | uuid | for reversals | Links reversal to original |
| `source_organization_id` | uuid | ✓ | Organization of the source record |
| `company_id` | uuid | ✓ | `get_company_id(source_organization_id)`, resolved **by the submit function**, never by the caller |
| `document_date` | date | ✓ | Business date (payroll date, invoice date) |
| `requested_posting_date` | date | ✓ | Proposed GL date; Finance may change within open periods |
| `period_reference` | text | ✓ | e.g. `2026-10` payroll month / service period |
| `currency` | char(3) | ✓ | ISO 4217 |
| `exchange_rate` | numeric | if ≠ base | Rate to base currency and `rate_date` |
| `total_amount` | numeric | ✓ | Sum of absolute line amounts on the debit side (control total) |
| `line_count` | int | ✓ | Control count |
| `source_approval_status` | text | ✓ | Must be the source's *final* state (`approved`/`locked`/`payroll_ready`); submit refuses anything else |
| `source_approved_by` / `source_approved_at` | uuid / timestamptz | ✓ | Who finalised it (for SoD) |
| `source_prepared_by` | uuid | ✓ | Maker |
| `source_snapshot_hash` | text | ✓ | SHA-256 of the canonical source payload; Finance re-reads the source and refuses if it changed |
| `payload` | jsonb | optional | Source-specific totals for audit (no PII beyond ids) |
| `status` | text | ✓ | see §6 |
| `submitted_by`, `submitted_at` | | ✓ | |
| `finance_accepted_by/at`, `posted_journal_id`, `posted_at`, `rejected_reason` | | | Finance side |
| `retry_count`, `max_retries`, `next_retry_at`, `last_error` | | | Worker (copied from `notifications_outbox` shape) |

## 4. Contract — lines

Proposed table `finance_posting_request_lines`.

| Field | Required | Rule |
|---|---|---|
| `request_id`, `line_no` | ✓ | |
| `posting_key` | ✓ | **Semantic** code owned by the source catalogue, never a GL account: payroll uses `payroll_components.code` (`BASIC`, `OT`, `ALLOWANCE_*`, `COMMISSION`, `EPF_EE`, `EPF_ER`, `SOCSO_EE`, `SOCSO_ER`, `EIS_EE`, `EIS_ER`, `PCB`, `NET_PAY`, `UNPAID_LEAVE`, `LEAVE_ENCASHMENT`); supply chain uses its 5 posting types |
| `side` | ✓ | `debit` / `credit` as the source understands it (Finance mapping may override per account rules) |
| `amount` | ✓ | ≥ 0, 2 dp in document currency |
| `quantity`, `unit` | optional | hours/days for OT/leave |
| `cost_centre_id` | optional in V1, required in Phase C | Finance cost centre (null allowed until it exists) |
| `department_id` | ✓ for HR | Department **as of the period** (from employment snapshot) |
| `business_unit_id` | optional | Reuse `hr_commission_business_units` |
| `employee_user_id` | optional | Only when a sub-ledger party is needed (net pay, final pay); aggregated payroll lines omit it |
| `counterparty_type` / `counterparty_id` | optional | `statutory_body` (EPF/PERKESO/LHDN), `organization`, `employee`, `marketplace` |
| `dimensions` | jsonb | Additional dimension codes, validated against the Finance dimension catalogue |
| `source_line_ref` | ✓ | Pointer to the source detail (e.g. `hr_payroll_run_item_components.id` or aggregate key) |
| `description` | ✓ | Snapshot text |

Balancing rule: Σdebit = Σcredit per request in document currency; the submit function rejects unbalanced requests (fixes the "force balance" pattern in `hr_post_payroll_run_to_gl`).

Aggregation: payroll accrual lines are aggregated by `posting_key × department (× cost centre)`; employee-level detail stays in HR and is reachable via `source_line_ref`. This keeps salary detail out of the GL (payroll confidentiality) while preserving drill-back for authorised users.

## 5. Functions (all `security definer`, `search_path` pinned, execute: `service_role` only)

| Function | Called by | Does |
|---|---|---|
| `finance_submit_posting_request(p_actor, p_request jsonb, p_lines jsonb)` | source module's **own** finalisation function in the same transaction (e.g. `hr_payroll_mark_ready_for_finance`) | Validates contract, resolves company, verifies source final state + snapshot hash, idempotent on `idempotency_key` (repeat returns the existing id), inserts header/lines with status `submitted` |
| `finance_preview_posting(p_request_id)` | Finance UI | Maps posting keys → accounts (payroll: `payroll_component_gl_map` effective at posting date; supply chain: existing rules), returns lines + validation errors |
| `finance_accept_posting(p_actor, p_request_id, p_posting_date)` | Finance UI | S&A `finance.journal.post` (or `finance.payroll_integration.manage` for payroll); SoD actor ≠ source preparer/approver; period open; status → `accepted` |
| `finance_post_request(p_request_id)` | worker / accept (auto mode) | Writes journal via the shared core, inserts `gl_document_postings(company, source_document_type, source_document_id||':'||revision)`, updates source pointer through the source's callback function, status → `posted` |
| `finance_reject_posting(p_actor, p_request_id, p_reason)` | Finance UI | Status → `rejected`; source is notified (status visible) and must issue a new revision |
| `finance_reverse_posting(p_actor, p_request_id, p_reason, p_reversal_date)` | Finance UI | Calls a period-checked, S&A-guarded reversal (replacing `is_hq_admin()` in `reverse_gl_journal`), writes a `reversal` request linked by `reverses_request_id` |

Source callbacks (one per module, owned by that module): e.g. `hr_payroll_on_posted(run_id, journal_id)` sets `hr_payroll_runs.gl_status/gl_journal_id`. Finance never updates source tables directly.

## 6. Status model

```
submitted ──validate ok──▶ ready ──accept──▶ accepted ──post──▶ posted ──reverse──▶ reversed
    │                         │                  │
    └──validate fail──▶ invalid   └──reject──▶ rejected     └──post error──▶ failed ──retry (≤ max_retries)──▶ accepted
                                                                              └── exhausted ──▶ dead_letter
```

- `auto` mode (per company × source document type, mirrors `gl_settings.posting_mode`) skips manual accept for low-risk types; **payroll accrual is always manual accept in V1.**
- Dead-letter rows surface in a Finance monitoring view and System Logs; no automatic resubmission.

## 7. Transport

| Layer | V1 choice | Reason |
|---|---|---|
| Producer → outbox | Same-transaction insert via `finance_submit_posting_request` | Atomic with source finalisation; no lost or phantom events |
| Outbox → posting | Cron worker `/api/cron/finance-posting-worker` (copy of notification worker), `cron_worker_leases` single owner, `FOR UPDATE SKIP LOCKED` batches | Proven in this codebase |
| Retry | `retry_count/next_retry_at` exponential backoff; only technical failures retry (lock timeout, transient) — validation failures go to `invalid` | |
| Dead letter | status `dead_letter` + System Logs entry + notification event | |
| Reconciliation | Daily view: source finals without request; requests without journal; journal totals ≠ request totals; `gl_document_postings` vs source pointer | Extends `v_documents_gl_status` idea |
| Human API | `/api/finance/postings/*` (list, preview, accept, reject, retry, reverse) | S&A gated |

## 8. Versioning rules

- `contract_version` major bump only for breaking field changes; Finance supports N and N-1.
- Posting keys are append-only per catalogue; retired keys stay valid for history.
- Every request stores the mapping version/effective date used at posting (`posted_mapping_ref`) for audit.

## 9. What sources must guarantee (applies to HR first)

1. Request is produced only from an **approved and locked** source state.
2. Source record is immutable after submission (or a revision is created).
3. Stable ids (UUID) and human numbers for every document and line.
4. Department (and later cost centre) **as of the period**, from a snapshot, not from current master data.
5. Control totals reproducible from source detail.
6. No GL account ids in the source payload.

Ordinary attendance, timesheets, leave applications and OT requests **never** produce requests — they only feed the payroll calculation, whose **approved run** is the financial document.
