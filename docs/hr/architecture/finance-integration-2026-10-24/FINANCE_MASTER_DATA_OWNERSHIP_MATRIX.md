# Finance Master Data Ownership Matrix

Branch `Enhancement03` @ `82da8cd0` · read-only · 2026-10-24. **[F]** = verified fact, **[R]** = recommendation. No columns are proposed for creation now; "future identifier" names are placeholders for later design.

Principle (owner-approved direction): **Finance owns accounting master data; HR (and every other module) references it.** Operational structure (organizations, departments, positions, employees) stays with its current owner.

---

## 1. Matrix

| Master data | Current table(s) [F] | Current owner / writer [F] | Scope key [F] | Recommended owner [R] | Consumers | Gaps / conflicts |
|---|---|---|---|---|---|---|
| **Legal entity** | none; implied by `organizations` with `org_type_code='HQ'` resolved by `get_company_id()` | Platform (organizations admin) | `company_id` = HQ org id | **Finance** owns the *accounting entity designation*; Platform keeps the organization row | GL, fiscal, bank, payroll mapping, tax | No explicit legal-entity record (registration/tax/SSM/EPF employer no. scattered or absent). One HQ = one ledger is implicit; a second HQ creates a second ledger silently. Employer statutory numbers (EPF/SOCSO/LHDN employer refs) have no home |
| **Organization** | `organizations` (parent_org_id, org_type_code, state_id, registration_no, tax_id, bank) | Platform / S&A org insert gate | — | **Platform** (unchanged) | everything | Partner orgs (distributor/shop/manufacturer) are counterparties, not entities — must never be treated as ledgers |
| **Department** | `departments` (organization_id, dept_code, manager, parent) | HR / Settings (shared with Supply Chain) | `organization_id` | **HR** (operational unit) | HR, S&A dept scope, approvals | Not a cost centre; reorganisations would rewrite cost history if used as one |
| **Cost centre** | none | — | — | **Finance** (new, Phase C) with an **HR-maintained mapping** department → cost centre, effective-dated | Payroll posting, expenses, budgets | Missing. HR Core V1 needs only the *slot* in its snapshots (see readiness gap analysis) |
| **Chart of Accounts** | `gl_accounts` | Finance (`finance.account.manage`) | `company_id` | **Finance** | All posting | HR currently seeds accounts (`seed_hr_gl_accounts`, `apply_hr_coa_template`) — [R] move these to Finance-owned templates; HR never creates accounts |
| **Default / control accounts** | `gl_settings`, `payroll_clearing_accounts` | Finance / HR Accounting screen | `company_id` | **Finance** | posting | HR Settings → Accounting edits Finance-owned data (gated `hr.settings.manage` in nav, `finance.payroll_integration.manage` in API) |
| **Employee** | `public.users` (identity), `hr_employees` (employment anchor, employee_no) | HR (identity: Platform) | `organization_id` | **HR** | Payroll, commission, Finance (as payee/sub-ledger party) | Finance should reference `users.id` (immutable) + `employee_no`; never copy names into Finance tables except as snapshot text |
| **Payroll components** | `payroll_components` (code, category, statutory, taxable) | HR Accounting screen (seeded) | `company_id` | **Joint:** HR owns the *component catalogue and calculation semantics*; Finance owns the *GL mapping* (`payroll_component_gl_map`) | Payroll calc, commission outbox (`COMMISSION`), GL | Duplicate mapping model `hr_gl_mappings` (retire for payroll). Component codes must be stable forever (used in history) |
| **Component → GL mapping** | `payroll_component_gl_map` (effective_from/to), `hr_gl_mappings` | HR screens | company / org | **Finance** | payroll posting | Effective dates exist but are ignored by `post_payroll_run_to_gl` |
| **Accounting periods** | `fiscal_years`, `fiscal_periods` | Finance (`finance.settings.manage`) | `company_id` | **Finance** | All posting | Payroll periods (`hr_payroll_runs.period_start/end`) are independent — correct; mapping is by posting date |
| **Payroll periods / cut-off** | `hr_payroll_runs` period columns | HR | organization | **HR** | Finance via posting date | No cut-off calendar (HR gap) |
| **Currency** | `accounting_currency_settings` (base), `exchange_rates` | Finance | `company_id` | **Finance** | All | `gl_journals` have no currency; HR compensation has `currency`; marketplace/storefront carry currency |
| **Tax codes** | `tax_codes` | Finance | `company_id` | **Finance** | AR/AP, e-commerce | unused |
| **Statutory rate sets** (EPF/SOCSO/EIS/PCB) | none (hard-coded) | — | — | **HR/Payroll** (regulatory payroll content), versioned | Payroll calc | Prior payroll report §6 |
| **Financial dimensions** | `gl_journal_lines.entity_type/entity_id` only | — | — | **Finance** (dimension catalogue) | posting, reporting | Missing: cost centre, department, business unit (commission has `hr_commission_business_units`), project/channel, employee |
| **Bank accounts** | `bank_accounts` (gl_account_id) | Finance | `company_id` | **Finance** | payments, payroll batches | Employee bank details live on `users` (sensitive) — HR-owned payee data |
| **Business units (commission)** | `hr_commission_business_units`, `_bu_brands` | HR commission | company | HR for commission; candidate Finance dimension later | commission, reporting | Name collision risk with a future Finance "BU" dimension → reuse, don't duplicate |
| **Counterparties (customers/suppliers)** | `organizations` (partners), storefront customers (text), marketplace shops | Supply chain / e-commerce | — | Source modules; Finance references | AR/AP | No customer/vendor master in Finance (AR/AP are views) |

## 2. Existing relationships [F]

```
organizations ──(get_company_id: nearest HQ ancestor)──▶ company_id ──▶ gl_accounts, gl_journals, fiscal_*, gl_settings,
     │                                                                  payroll_components, payroll_component_gl_map,
     │                                                                  payroll_clearing_accounts, bank_accounts, tax_codes
     ├── departments (organization_id) ◀── hr_employees.department_id, users.department_id (projection)
     └── hr_employees (organization_id, user_id → users.id, employee_no)
            ├── hr_employee_compensation / allowances / deductions (organization_id, employee_id = users.id)
            ├── hr_payroll_runs (organization_id) ── hr_payroll_run_items (employee_user_id)
            │        └── gl_journal_id → gl_journals ; payroll_journals(component_id → payroll_components)
            └── hr_commission_* (company_id) ── hr_commission_payroll_transfers(payroll_component_code, payroll_run_id, gl_journal_id)
```

## 3. Conflicts with the current organization architecture

| # | Conflict | Impact | Recommendation [R] |
|---|---|---|---|
| C1 | HR scopes by `organization_id`, Finance by `company_id` | A payroll run of a warehouse org posts to its HQ ledger — correct today; ambiguous if an employee's org has no HQ ancestor | Contract carries **both** `source_organization_id` and resolved `company_id`; posting refuses when `get_company_id` is null |
| C2 | Actor-derived company in posting functions | Wrong ledger for multi-company actors | Always derive company from the source record |
| C3 | Departments are operational and editable | Using them as cost centres rewrites history | Separate cost centre master + effective-dated mapping; HR snapshots carry the department **and** (later) cost centre id at the time |
| C4 | HR seeds Finance accounts | Two owners of CoA | Finance templates; HR requests mappings |
| C5 | Two payroll mapping models | Divergent postings | Model 1 canonical |
| C6 | Partner orgs share the `organizations` table with internal orgs | A posting "for" a distributor could be mistaken for an entity | `company_id` must always be an HQ id (assert in posting) |

## 4. Owner decisions needed

1. Confirm **one HQ organization = one legal entity / ledger** as the V1 rule (or introduce an explicit legal-entity record in Phase C).
2. Confirm **cost centre is a Finance master** distinct from departments, with HR maintaining the department → cost-centre mapping.
3. Confirm **Model 1** (`payroll_components` + `payroll_component_gl_map`) as the only payroll mapping model.
4. Where employer statutory identifiers (EPF employer number, SOCSO employer code, LHDN E-number) live: proposed on the legal-entity designation (Finance/Payroll shared read).
