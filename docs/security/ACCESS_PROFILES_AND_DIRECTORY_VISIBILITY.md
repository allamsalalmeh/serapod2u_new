# Access Profiles and cross-organization directory

Branch: `issues-fixing-oct2`. Migrations (left unapplied, run in this order, after the existing S&A migrations):

1. `supabase/migrations/20261005100000_sa_directory_visibility.sql`
2. `supabase/migrations/20261005110000_sa_access_profiles.sql`

Both are additive; the UI degrades gracefully (and says why) while either is missing.

## 1. People & Access directory (manufacturer visibility)

Root cause: `overview/route.ts` loaded people with `.eq('organization_id', <admin's organization>).limit(500)` and
`PeopleAccessPanel` searched only that list, so partner users (e.g. `manu@dev.com`, organization = manufacturer) never
appeared and anything past 500 was silently dropped. `data.people` is still used by other tabs only to resolve names.

Now: `GET /api/security-access/people` (security.access.view) → `sa_directory_page` (server-side search, filter,
pagination, counts). Which organizations an administrator may see is decided in the database by
`sa_authorized_organizations(actor, permission)` using existing semantics:

| Permission mode | Authorized organizations |
|---|---|
| `LEGACY_ENFORCED` / `SHADOW` (today) | central Super Admin (legacy level 1): every organization. Anyone else: none. |
| `NEW_ENFORCED` / `LEGACY_RETIRED` | descendants-or-self of the actor's active memberships where `sa_actor_has_permission(actor, perm, {organization_id})` ALLOWs. HQ membership alone never implies other organizations (an HQ-scoped assignment covers HQ's own subtree only). |

* A supplied `org` that is not authorized raises `sa_directory_org_forbidden` (403). Memberships in unauthorized
  organizations are never returned for a visible person.
* **Viewing is not granting**: per membership, `sa_directory_visible_memberships` computes `grantable` from
  `security.role.assign` (active membership, active account, not self). `sa_assign_role` /
  `sa_create_assignment_internal` independently re-check actor authority **in the target organization**, an active
  target membership, scopes inside that organization, SoD and self-assignment (unchanged; covered by tests).
* People with no active membership are listed ("No membership") and cannot be granted; nothing is created by viewing.
* The loader selects only: id, name, email, legacy role code, active flag, organization (name/type), memberships and
  assignments. No credentials, phone, banking or HR data.

## 2. Access Profile model

An Access Profile **is** a business role (`sa_business_roles`); evaluation, assignments, scopes, SoD and the audit log
are unchanged — there is no second engine.

| Kind | Stored as | Rules |
|---|---|---|
| Standard | `source = 'template'` | Protected: cannot be edited, published over, retired or deleted; only copied. |
| Custom | `source = 'new'` | Created/copied as `status = 'draft'` (not assignable). Edited only via a draft. |
| Compatibility | `source = 'legacy'` | Not a profile. Lifecycle-managed; not editable, copyable or manually assignable. |

Lifecycle (`sa_access_profile_drafts`): `draft → in_review → published` (or `discarded`).
* A draft never affects authorization (evaluation reads `sa_business_role_permissions` only).
* Permissions are explicit keys; there is no module/area inheritance, and permissions added to the catalogue later are
  not included anywhere. The module → area → operation picker is navigation only.
* `sa_profile_publish_preview`: added/removed permissions, every holder (user, organization, scopes), **new** SoD
  conflicts for existing holders, and an impact hash. `sa_publish_profile_draft` requires the matching hash (stale →
  rejected), a reason ≥ 10 characters when holders exist, no blocking SoD conflict, and (when holders exist) a
  publisher different from the submitter (`access_profile.allow_self_publish` setting lifts this). Each holder gets an
  `assignment.profile_changed` audit row (real actor, reason, added/removed) plus one `access_profile.published` row.
* Assigned profiles can't be deleted (trigger) or retired (`sa_profile_has_holders`); retire after revoking.
* `sa_save_business_role` (old editor) now re-checks the actor and refuses profiles with holders.
* Applicability: `applicable_account_types` (internal/partner, derived from org type MFG/DIST/SHOP = partner) and
  `applicable_org_types`; `sa_assign_role` refuses a non-applicable target organization. Partner-applicable profiles may
  not hold `hr.*`, `security.*`, `platform.user.*`, `platform.data.*`, `finance.data.*`.
* Authority for management: `security.role.manage` (central Super Admin while that permission is on a legacy mode).

## 3. Add User (Role & Access)

Account type (internal / partner, from the organization type) → organization → Access Profiles, each with its **own
explicit scope** (never defaulted, never one shared broad scope) → "Review of resulting access". The organization only
filters the profiles offered; department, job title and manager status grant nothing. Business-unit/department
records are not invented: the existing HR fields stay where they are.

Provisioning: `identity_provision` (re-created, otherwise identical) calls `sa_assign_initial_profiles` inside the
provisioning transaction: any failing profile (authority, applicability, scope, SoD, self-assignment) aborts
everything and the existing compensation removes the auth identity created by that request, so a retry is clean — no
partial access is ever left. Sensitive profiles (`security.*`, `hr.data.reset`, `platform.data.destructive`,
`finance.data.reset`) are never assigned at creation; assign them afterwards in People & Access (HR reset still
requires Super Admin plus the explicit reset permission — untouched). Existing users: manage profiles in Security &
Access → People & Access (same authorization). Partner users get no HR/ESS enrollment from a profile.

## 4. Remaining legacy-level dependencies (Level 1/10/20/30/40 are NOT removed)

* `users.role_code` / `roles.role_level` remain required fields (Add User still asks for the "Legacy level (compatibility)").
* ~230 application files and ~37 migrations still read `role_level`/`role_code` (route guards, `checkPermissionForUser`,
  RLS helpers such as `can_access_org`).
* `sa_legacy_is_super_admin` (level 1) is how the central Super Admin is recognised for S&A governance functions while
  `security.*` permissions are on a legacy mode, and for the directory scope above.
* Compatibility roles (`legacy-<role_code>`) and automatic (`backfill`/`derived`) grants continue to mirror the level;
  the UI reports them separately as Legacy / Automatic access. Retiring a permission (`LEGACY_RETIRED`) removes the
  legacy *check* for that operation only — not these dependencies.
* The HR employee/ESS lifecycle (`employee-self-service` baseline) is keyed to the legacy role code.
* Later retirement would need: replace level checks in routes/RLS with S&A permissions, migrate
  `sa_assert_actor_permission`'s legacy fallback and super-admin recognition to explicit S&A assignments, stop
  generating compatibility roles, drop `role_code` from provisioning, and decide an S&A replacement for level-based
  org-management rules.

## 5. Tests

* `supabase/tests/security/sa_profiles/run.sh <disposable sa_prof_test* DB url>` loads the **real** S&A migrations
  (wave1 foundation, final governance, grant-keeps-automatic) on minimal platform stand-ins, then the new migrations,
  then the suites (directory scope in legacy and NEW_ENFORCED semantics, forged organizations, beyond-500 search,
  read-only checks, grant/self/target-org enforcement, profile protection, drafts, publish impact/conflicts/stale/
  self-review, retirement, applicability, multi-profile atomicity, lifecycle). Never run against Supabase.
* Vitest: `directory`, `profiles`, People/Access Profiles panels, Add User selector, provisioning mapping.

## 6. QR Batch access for manufacturers (2026-10-06)

Migration: `supabase/migrations/20261006100000_sa_qr_batch_operator_profile.sql` (requires 20261005110000).

Investigation result for `qr.batch.manage`:

| Question | Finding |
|---|---|
| Missing profile? | **Yes.** Registered (catalogue, mode SHADOW, enforcement-ready, five route guards, `mark_batch_as_printed` guard) but contained in **no** standard or custom profile. |
| Hidden by classification/filters? | No. `classifyPermission('qr.batch.manage')` = Supply Chain → QR & Traceability; applicability filters had nothing to hide. |
| Already held? | Not by Manu: it holds no non-baseline business role. Compatibility roles (`legacy-<role>`) carry it for level ≤ 40 only for internal staff; nothing explicit. |
| Missing runtime enforcement? | **Partly.** A manufacturer holding the permission could (a) print-mark ANY batch through the SECURITY DEFINER `mark_batch_as_printed` (only the actor's own organization was checked), (b) download ANY batch's Excel through `/api/qr-batches/download` (service-role signed URL, no ownership check), (c) read any batch's progress, (d) receive system-wide QR verification statistics, and (e) read every batch through the `qr_batches` SELECT policy. |

Ownership model: an H2M order is owned by HQ (`company_id`/`buyer_org_id`) and placed **with** the manufacturer
(`orders.seller_org_id`). `qr_batches.company_id` is the HQ, so the manufacturer party is identified through the
order's seller, never through the batch's organization. The same permission therefore distinguishes HQ and
manufacturer operations only together with this party rule (no new permission was needed):

* Profile **QR Batch Operator** (`qr-batch-operator`, standard): only `qr.batch.manage`; applies to HQ and Manufacturer
  organizations. No warehouse, order-approval or security rights.
* `sa_assert_qr_batch_party` injected into `mark_batch_as_printed` (partners only; HQ/internal behaviour unchanged).
* `qr_batches` SELECT: manufacturer principals see only batches of their own orders.
* Routes: download and progress apply `canAccessBatchForOrder` (partners: `seller_org_id` must equal their organization);
  generate/process already did; `qr-monitoring/stats` (system-wide) refuses partner organizations.
* QR quantity/buffer logic and HQ behaviour are untouched.
* Not changed: `qr.batch.manage` stays enforcement-ready only because these paths are now guarded; no mode is changed.
  Whether the manufacturer menu entry "QR Batches" appears depends on the existing menu rules (not changed here).

## 7. Coverage audit (static; `coverage-audit.ts` / test)

115 permissions are known (Wave 1 + Final Wave + Identity + Stage 2D + HR data). Findings:
* **No orphans**: every enforcement-ready key, every route-coverage permission and every profile permission is a known
  permission; **no permission falls into "Other / Unmapped"** in the shared taxonomy.
* **Genuinely missing before this change:** `qr.batch.manage` had no profile (fixed above).
* **Permissions with no standard profile (informational, not errors; granted via custom profiles or
  compatibility/automatic access):** customer.campaign.manage, customer.loyalty.adjust, customer.shop.manage,
  customer.support.manage, ecommerce.channel.manage, finance.data.reset, hr.ai.use, inventory.adjustment.post,
  inventory.opening_balance.manage, inventory.report.view, inventory.return.manage, inventory.return.request,
  inventory.stock_config.manage, inventory.transfer.cancel, manufacturing.adjustment.manage,
  manufacturing.production.manage, manufacturing.scan.reverse, platform.data.destructive, platform.identity.delete,
  platform.organization.manage, platform.settings.manage, product.catalog.manage, reporting.analytics.view,
  security.emergency_access.grant, supply_chain.document.acknowledge, supply_chain.document.manage,
  supply_chain.order.cancel, supply_chain.order.create, warehouse.receipt.post, warehouse.shipment.manage.
  No profile was invented. Note for a follow-up: `manufacturing.production.manage`, `manufacturing.scan.reverse` and
  `manufacturing.adjustment.manage` are manufacturer-facing; give them a profile only after their own party scope is
  verified the way it was for QR batches.
* **No route reference found** (informational): `inventory.stock_count.create` (enforced by the stock-count table RLS
  gates, not a route) and `security.emergency_access.grant` (intentionally unavailable until MFA step-up exists).
* Nothing was marked enforcement-ready; hierarchy and profile membership never grant or inherit access.

## 8. Directory filters and membership messaging (2026-10-07)

Migration: `supabase/migrations/20261007100000_sa_directory_filters.sql` (read-only `sa_directory_page_v2`; v1 stays
and is used when no new filter is selected and the migration is missing).

* **User category** = `users.principal_type` (INTERNAL_EMPLOYEE, MANUFACTURER_USER, DISTRIBUTOR_USER, SHOP_STAFF,
  CONSUMER) — the classification identity/User Management already derive (`identity_derive_principal_type`:
  store scope ⇒ CONSUMER; portal + SHOP ⇒ SHOP_STAFF, so a GUEST role code in a shop is shop staff). A null value is
  shown as **Unclassified**; it is never inferred from membership or role code.
* **Organization type** (HQ, Manufacturer, Distributor, Warehouse, Shop — User Management's labels), searchable
  **Organization**, name/email **search**, and under *More filters*: **Account status** (users.is_active) and
  **Business membership** (active, in-date membership in scope). The access chips (granted / temporary) remain.
* Every filter is applied in the database before pagination and only inside the authorized organizations
  (`sa_authorized_organizations`, unchanged); a forged organization is still rejected. Counts cover the selected
  scope after the organization/category/type/status/membership filters; search and the access chip narrow the list only.
  The organization list follows the organization type, and a mismatching organization is reset; other incompatible
  combinations return an empty result with "Clear filters".
* **Missing membership is a normal state**: no warning in rows; details say "No active business membership". Grant
  stays unavailable (backend rules unchanged) with a "Grant unavailable" button (keyboard/touch, `aria-expanded`) that
  reveals "An active business membership is required to assign an Access Profile." Other blockers keep their own
  neutral text (own row, inactive account, inactive membership, view-only authority); real request failures stay red.
  A User Management link appears only for partner users when the administrator holds `platform.user.manage`.
