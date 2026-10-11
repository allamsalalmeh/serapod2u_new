# Group Policy eligibility by organization type

Status: implemented on `issues-fixing-oct2`. Migration `20261030100000_sa_policy_org_type_eligibility.sql` is **not applied**
anywhere. Localhost shares the staging database, so apply it on staging first, by hand.

## 1. What existed before (audit, 2026-10-11, staging read-only)

| Area | Finding |
|---|---|
| Metadata | `sa_business_roles.applicable_org_types` / `applicable_account_types` (20261005110000). **Empty = any organization.** 42 of 51 policies had no list. |
| DB check | `sa_profile_applicable` was used by `sa_assign_role` and `sa_assign_initial_profiles` only. **Access-request approval** (`sa_decide_access_request` → `sa_create_assignment_internal`) and re-granting a revoked row did **not** check it. |
| Org types | `sa_org_account_type` = partner for MFG/DIST/SHOP, otherwise "internal", so END_USER (consumers) and INDEP counted as HQ staff. WH was never classified. |
| App | `recipient-eligibility.ts` had a Manufacturer-only rule (Manufacturing permissions only) and ESS HQ-only. HQ, DIST and SHOP had no type rule, and Add User duplicated the applicability check inline in `actions.ts`. |
| People & Access | The policy list was filtered by the Manufacturer rule only. The **Module** dropdown was built from every grantable policy, ignoring eligibility. |
| Custom editor | "Applies to organization type (empty = any)". Partner checks only when account type "partner" was ticked. |
| Gap examples (proven by the negative control in the SQL suite) | Warehouse Manager → Distributor; Order Approver → Shop; any policy → End User; Supply Chain Full Access → Shop through an approved access request; unclassified custom policy → Manufacturer. |

Organization types on staging: HQ 1, WH 3 (all children of HQ), MFG 15, DIST 25, SHOP 741, END_USER 1, INDEP 0.

## 2. The rule (one model, two mirrors)

`public.sa_policy_org_type_ineligibility(role, org_type)` returns `null` when the policy is eligible, otherwise the reason. `app/src/lib/security-access/recipient-eligibility.ts` mirrors it, and a unit test compares the mirror with the migration text.

1. The organization type must be classified and assignable (`sa_org_type_eligibility`): HQ, WH → internal; MFG, DIST, SHOP → partner; END_USER, INDEP and anything unknown → **not assignable**.
2. The policy must **list** that type in `applicable_org_types`. An empty list is **unclassified, eligible nowhere**. Missing metadata never means unrestricted.
3. `applicable_account_types` (internal / partner), when set, must also match.
4. Every permission must suit the type. Internal types accept any permission. DIST/SHOP accept nothing HQ-only (`hr.*`, `security.*`, `platform.*`, `finance.*`). MFG accepts `manufacturing.*` only.
5. ESS stays HQ-only (20261014100000).

It is judged on the **target membership's** stored organization type. It is never judged on the grantor's organization, a submitted value, or the scope. Eligibility, grantor authority (`security.role.assign`, sensitive-permission guard, scope guard), existing coverage and SoD are separate checks. None replaces another.

Decision A: an HQ administrator still **sees** every policy in Security & Access → Group Policies (the admin catalogue now shows "Unclassified · not grantable" where relevant). Visibility does not make a partner policy grantable to an HQ membership.

Decision B: custom policies follow exactly the same rule.

## 3. Enforcement points

| Path | Application | Database |
|---|---|---|
| Add User (picker + submission) | `listInitialAccessRoles` / `validateInitialSelections` | `sa_assign_role` → `sa_profile_applicable`; trigger |
| Edit User | same loader; existing ineligible grants shown as "not eligible", never removed | trigger (grants go through the assignments API) |
| People & Access grant / preflight | `PeopleAccessPanel` filter + module list; `checkGrant` → `essGrantAllowed` | `sa_assign_role`; trigger |
| Direct API calls | `POST /api/security-access/assignments`, `/access-requests` (submit) | trigger |
| Access-request approval | — | **trigger** (previously unchecked) |
| Re-grant / reactivation of a revoked row | — | trigger (status → active) |
| Lifecycle (`backfill`, `derived`), Root Access | not affected | not affected |

Trigger `sa_assignment_eligibility_guard` runs BEFORE INSERT/UPDATE on `sa_role_assignments` for sources `manual` / `access_request`. It takes a share lock on the policy row, so a grant and a concurrent eligibility change serialize. Both orders are tested.

Rollout compatibility: the app reads `sa_org_type_eligibility`. If the table is verifiably missing, the app uses the `legacy` model, which matches what the un-migrated database enforces. Any other read failure uses the strict model (fail closed).

## 4. Standard policy eligibility matrix (after the migration)

"Admin catalogue" = visible to authorized HQ administrators in Group Policies, not grantable to that type.

| Policy | Key permissions | HQ | WH | MFG | DIST | SHOP | Basis |
|---|---|---|---|---|---|---|---|
| Security & Access Full Access, Security Administrator, Access Reviewer | `security.*` | ✔ | – | – | – | – | HQ administration; HQ-only permissions |
| Identity Administrator, User Password Administrator, Profile Administrator, Platform & Settings Full Access, System Log Viewer, Notification Monitor Viewer | `platform.*` | ✔ | – | – | – | – | System administration |
| Employee Self-Service | `hr.self_service.use` | ✔ | – | – | – | – | HQ-only decision (20261014100000) |
| HR Manager, HR & Payroll Full Access, HR Data Reset Admin, Internal Directory Viewer, Payroll Officer / Approver / Finance Approver | `hr.*` (+`finance.module.view`) | ✔ | – | – | – | – | HR is HQ-only |
| Finance Admin / Full Access / GL / AR / AP Clerk / Viewer / Statement Preparer / Approver, Payment Approver | `finance.*` | ✔ | – | – | – | – | The company ledger |
| Customer & Growth Full Access, Customer Report Viewer ("cross-shop"), Customer Messaging Manager, Support Inbox Admin, Storefront Banner Manager, Loyalty Admin, Roadtour Manager, CRM / Marketing / E-Commerce User, E-Commerce Admin, Outdoor Store Operator | `customer.*`, `ecommerce.*`, `marketing.*`, `roadtour.*` | ✔ | – | – | – | – | Cross-shop administration; partner use unapproved |
| Supply Chain Full Access | 30 keys across inventory / manufacturing / orders / QR | ✔ | – | – | – | – | Not a partner policy (explicitly) |
| Stock Adjustment Administrator | `manufacturing.adjustment.administer` ("across manufacturers") | ✔ | – | – | – | – | Cross-manufacturer |
| Order Approver | `supply_chain.order.approve` | ✔ | – | – | – | – | Partner use pending (see 6) |
| Catalogue User | `product.catalog.view` | ✔ | – | – | – | – | Partner use pending (see 6) |
| Warehouse Operator / Manager | `inventory.stock_count.*`, `inventory.transfer.*` | ✔ | ✔ | – | – | – | HQ-owned warehouse sites; WH listed explicitly |
| Order Creator | `supply_chain.order.create` | ✔ | – | – | ✔ | ✔ | Approved 2026-10-08 (20261028100000), kept |
| QR Batch Operator | `qr.batch.manage` | ✔ | – | declared, **blocked** | – | – | Lists MFG, but QR is not Manufacturing-only (see 6) |
| Manufacturing Full Access — Manufacturer | `manufacturing.{production,adjustment,scan}` | admin catalogue | – | ✔ | – | – | 20261012100000 |
| Manufacturing Production Operator / Adjustment Handler / Scan Reversal | one `manufacturing.*` each | admin catalogue | – | ✔ (draft, not assignable) | – | – | 20261010100000 drafts |

Only empty lists are filled. Explicit lists are never overwritten, and no standard policy gains a partner type. A unit test asserts that only HQ / WH were added.

Custom policies on staging:

| Policy | Org types | Account types | Result |
|---|---|---|---|
| supply-chain-full-access-custom-manufacture | MFG | internal | Grantable nowhere: the account type contradicts the org type, and the permissions are not Manufacturing-only. Unchanged; 0 holders. |

## 5. Custom policy approach

- The editor shows **Eligible organization types** (HQ, Warehouse, Manufacturer, Distributor, Shop) as a required, explicit choice. "Empty = any" is gone. A draft can be saved incomplete, but not submitted or published without at least one type (`sa_profile_org_types_required`).
- Permissions incompatible with any chosen type are disabled in the editor and refused by the database (`sa_profile_org_type_incompatible`), for example Finance for Shop or Inventory for Manufacturer.
- Adding a type to a published policy re-checks every permission. Narrowing a custom policy is refused while an administrator grant in an excluded type is active (`sa_profile_eligibility_has_holders`). Revoke those grants first; nothing is revoked automatically.
- Only Security & Access profile managers can change eligibility (existing `security.role.manage` functions; no direct table access). Standard policies change only by migration. Every change is logged as `access_profile.eligibility_changed` with before/after (system actor for migrations).
- Existing custom policies are never expanded. A custom policy with no types becomes "Unclassified · not grantable" until an administrator classifies it.

## 6. Decisions still needed (not enabled; nothing broadened)

1. **WH memberships.** Only Warehouse Operator and Warehouse Manager list WH. Should WH staff also be eligible for other internal policies (for example Supply Chain Full Access or Notification Monitor)? Staging has WH backfill grants for messaging, support inbox, outdoor store and notification monitor.
2. **Catalogue User for Distributor / Shop.** Staging has backfill grants (2 DIST, 4 SHOP).
3. **Order Approver for Distributor.** Do distributors approve their shops' orders?
4. **Warehouse Operator / Manager for Distributor.** Do distributors run their own warehouses?
5. **QR Batch Operator for Manufacturer.** 20261006100000 built ownership guards for manufacturers, but the Manufacturer rule (Manufacturing-only, 20261010100000) blocks it. Approving it means extending the MFG permission rule to `qr.batch.manage` (DB function + TS mirror).
6. **Customer & Growth policies for Manufacturer / Shop.** Staging has legacy backfill grants of messaging, report viewer, support inbox, outdoor store and profile administrator to MFG (5 each) and some SHOP.
7. **INDEP organizations.** Classified not_assignable until a use case is approved.

## 7. Existing incompatible grants (staging, read-only replay of the new rule)

450 active non-compatibility grants; **72 would be flagged; 0 are administrator grants (`manual` / `access_request`)**. All are lifecycle grants derived from legacy roles, and the eligibility guard never touches lifecycle sources:

| Policy | Source | Org types (count) |
|---|---|---|
| employee-self-service | derived | MFG 6, SHOP 4, WH 4, DIST 2 (handled by the ESS HQ-only migration 20261014100000) |
| hr-internal-directory-viewer | backfill | MFG 6, SHOP 4, WH 4, DIST 2 |
| catalog-viewer | backfill | SHOP 4, DIST 2 |
| customer-messaging-manager, customer-report-viewer, support-inbox-administrator | backfill | MFG 5, SHOP 1, WH 1 each |
| outdoor-store-operator, profile-administrator | backfill | MFG 5, WH 1 each |
| notification-monitor-viewer | backfill | WH 1 |

Remediation plan (not automated):

1. After applying, run `select * from public.sa_policy_eligibility_audit();` per environment. Production may differ from staging.
2. ESS rows are covered by 20261014100000.
3. HR internal directory and profile administrator for partners are HQ-only permissions (`hr.*`, `platform.*`). Remove them through the legacy-role lifecycle (change the partner users' legacy role), or revoke with a reason in People & Access. Recommend doing this first.
4. The Customer & Growth / Catalogue rows wait for decisions 2 and 6. If approved, add the type to the policy by migration; if not, revoke with a reason.
5. Re-run the audit until it is empty or every row is an accepted exception.

## 8. Verification

- `supabase/tests/security/sa_policy_eligibility/run.sh <disposable sa_prof_test* db>`: real S&A migrations, a negative control on the unpatched schema, the migration applied twice, all 16 required scenarios, and two concurrency races. **ALL PASSED.**
- Vitest: `recipient-eligibility`, `add-user-selections`, `add-user-preflight`, `add-user-create-guards`, `group-policy-add-user`, `stage2-provisioning-ux`, assignments route, `PeopleAccessPanel`, `AccessProfileSelector`, `edit-access`. 1182 passed. Four failures are unrelated and pre-existing: `emergency-access-readiness` ×2, `ui-contract` "Technical Access", and the Add User identity-match text.

## 9. Rollout and rollback

Prerequisites: 20261005110000, 20261009100000, 20261015100000 and 20261020100000 are applied. Check on the target that every active policy you expect to grant has `applicable_org_types` after the migration:

```sql
select * from public.sa_policy_eligibility_catalogue();
```

Rollback steps are in the migration header. Dropping the triggers and restoring the 20261005110000 `sa_profile_applicable` is enough to return to the old behaviour. The app then sees the classification table missing only after the table is dropped, and switches to the legacy model.

## 10. Localhost BAT / UAT checklist

Apply the migration on staging first; localhost uses the staging database.

1. Users → Add User → HQ organization: HQ policies are listed. Order Creator is listed. Manufacturing Full Access — Manufacturer is **not** listed. The "N Group Policies are not available for Headquarters accounts" note lists it with a reason.
2. Add User → a Manufacturer: only Manufacturing Full Access — Manufacturer is listed. QR Batch Operator appears in the "not available" note.
3. Add User → a Distributor, then a Shop: only Order Creator is listed.
4. Add User → a Warehouse: only Warehouse Operator / Manager.
5. Tick a policy under HQ, then switch the organization to a Shop: the selection is removed with a visible notice. The Review step shows only remaining selections.
6. Edit User for a Shop user who holds an HQ-only policy (for example a backfill Catalogue User): the grant is shown with "Not eligible for this organization type…". Saving without changes revokes nothing.
7. Security & Access → People & Access → Grant a Group Policy → a person with a Distributor membership: the Module list contains only modules with eligible policies, and HQ-only policies are absent. Switching to the same person's HQ membership brings them back.
8. Group Policies tab (as HQ admin): partner policies are visible with their org-type chips. A custom policy without types shows "Unclassified · not grantable".
9. New custom policy: Submit is disabled until an organization type is chosen. Ticking Shop disables Finance / HR / Security / Platform permissions. Ticking Manufacturer disables non-Manufacturing permissions.
10. A published custom policy granted to a Distributor: removing Distributor from its types is refused at publish with the "revoke those grants first" message.
11. Approve a self-service access request for an ineligible policy: the approval fails with "not eligible for the organization type".
12. Revoke an eligible grant and grant it again: works. Root Access card and grants are unchanged.
