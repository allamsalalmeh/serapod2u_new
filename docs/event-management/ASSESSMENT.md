# Event Management — Repository Assessment

Read-only findings. "Verified" = observed in source/schema on the `event_management`
branch (base `origin/staging` @ `9e27404d`; current HEAD `d7388f7d`, two documentation-only
commits ahead of staging) unless marked **"issues-fixing-oct2 only"**.
"Proposed" = recommendation, not yet implemented. Where the live database could
not be read, that is stated explicitly.

**Access direction (latest):** initial Event Management access reuses the existing **Marketing
parent gate** `marketing.module.view` (see §7) for navigation, admin pages and APIs, with org
isolation. Direct database access to `event_*` tables and RPCs is **denied** to `anon`/`authenticated`
— all access goes through server endpoints (Strategy B, see §7). `event.*` permissions, their seed
migration, and the Full Access extension are **deferred** to a future granular-access phase, which
depends on the shared S&A framework on `issues-fixing-oct2` (Group Policies, Full Access, destination
navigation). See README.md for the integration sequence.

---

## 1. Navigation & route registration

### Customer & Growth nav (primary, active)
- `app/src/modules/customer-growth/customerGrowthNav.ts`
  - `customerGrowthModules` — top-level modules (CRM, Marketing, Loyalty, Catalog, E-commerce).
  - `customerGrowthNavGroups` — card groups for the landing page **and** top-nav dropdowns.
  - Group `cg-marketing` ("Marketing") children, in order:
    `landing-pages` → `journey-builder` → `roadtour` → `marketing` (WhatsApp).
  - `filterCustomerGrowthNavGroups(allows)` filters children by the S&A snapshot.
- Consumed by:
  - `app/src/modules/customer-growth/components/CustomerGrowthLandingView.tsx` (overview card)
  - `app/src/modules/customer-growth/components/CustomerGrowthTopNav.tsx` (top dropdown)
- **To place Event Management below Road Tour**, insert a new child
  `{ id: 'event-management', label: 'Event Management', route: '/marketing/event-management', … }`
  after the `roadtour` child in `cg-marketing`, and add the id to
  `isCustomerGrowthViewId` / `getActiveCustomerGrowthModule` / `getActiveCustomerGrowthGroup`.

### Marketing module nav (legacy, parallel system)
- `app/src/modules/marketing/marketingNav.ts`
  - `marketingNavGroups` → "Campaigns & Outreach": `landing-pages`, `journey-builder`, `marketing`.
  - **Does not list Road Tour** today — out of sync with the customer-growth nav. Consumed by
    `app/src/modules/marketing/components/MarketingTopNav.tsx`, `MarketingLandingView.tsx`, and
    legacy dashboard `app/src/components/dashboard/DashboardContent.tsx`.
- `marketingViewToPath` / `marketingPathToView` / `resolveMarketingSlug` / `isMarketingViewId` /
  `marketingHrefForView` must be extended if the legacy marketing shell is still reachable.
  Verify which shell actually renders `/marketing/*`; both exist.

### Route/page layout convention
- Admin pages: `app/src/app/<module>/` with thin `page.tsx` + `_lib.ts` per segment
  (e.g. `customer-growth/`, `roadtour/`, `marketing/`).
- API handlers: `app/src/app/api/<module>/.../route.ts`.
- Public pages: `app/src/app/scan/page.tsx` is the RoadTour QR entry; middleware whitelists public paths.

---

## 2. Ellbow Journey Builder & public pages (verified assets)

### Asset files on disk (actual references)
- `app/public/images/ellbow-mobile-ready-assets/`
  - `webp/` (production): `01-ellbow-cat-mascot-full.webp`, `04-ellbow-verified-shield-cat.webp`,
    `05-ellbow-home-icon.webp`, `06-ellbow-rewards-gift-icon.webp`, `07-ellbow-scan-icon.webp`,
    `08-ellbow-product-pack-icon.webp`, `09-ellbow-profile-avatar-icon.webp`,
    `15-ellbow-mobile-hero-background.webp`, `16-ellbow-campaign-thumbnail.webp`,
    `18-ellbow-featured-reward-gift.webp`, plus kidney/urinary/protection icons.
  - `png/` (transparent sources), `reference/` (design references only — not UI backgrounds).
- `app/public/images/ellbow_icons_pack/` — PNG icon set (same numbering).
- `app/public/images/ellbow-collect-points-popup-pack/` — animation pack
  (`webp-mobile/`, `png-transparent/`, `source-renders/`, `reference/`).
- `app/public/images/ellbow_avatar.png` — standalone avatar (not referenced in code).

### How they are loaded in code
- `app/src/components/journey/petfood/EllbowLiveExperience.tsx`
  - `const ASSET_ROOT = '/images/ellbow-mobile-ready-assets'`; `assets` map to `webp/*` (+ one `png/`).
  - Exports `EllbowLiveHome`, `EllbowBottomNavigation`, `ResilientImage` (onError fallback).
- `app/src/components/journey/petfood/EllbowHomePreview.tsx`
  - `const ICON_ROOT = '/images/ellbow_icons_pack'`; `EllbowAsset` renders `{ICON_ROOT}/{file}.png`.
- `app/src/components/animations/GenuineProductAnimation.tsx`
  - `const ELLBOW_ASSET = '/images/ellbow-mobile-ready-assets/png'`; `ellbow` prop switches to the
    teal/mint cat + verified-shield celebration.

### Ellbow palette (reuse for public pages)
Teal/mint `#087d78 #0b9790 #39b9ae #34999d #0b8e88 #0b968e`; pink `#d44368 #cf3f64 #c93d62`;
dark text `#17283a / #173146`; cream surfaces `#f7f8f8 / #fbfaf9`.

### Brand/logo caveat
No code path references a single "Ellbow logo" file. Brand identity is the mascot/icon packs
plus the `ELL`/`B`/`W` wordmark in `EllbowHomePreview.tsx`. **Do not invent a logo path.**
`brands.logo_url` exists as a column; whether an Ellbow logo row exists is **DB data not
readable from this checkout** — verify before using it.

### Related Ellbow program context
- `app/src/lib/server/ellbow-catalog.ts` — `getEllbowContext({ permission })` resolves the
  caller's org and the `loyalty_programs` row with `code = 'ellbow'`.
- `app/src/app/api/engagement/catalog/ellbow/public-rewards/route.ts` — public Ellbow endpoint
  resolves a RoadTour token, asserts `pet_food` experience, reads the org's `ellbow` program.

## 3. Road Tour — event/staff/QR/attribution patterns (reuse)

- `app/src/lib/roadtour/server.ts`
  - `resolveRoadtourByToken(token)` — server-side token → QR record + campaign + account manager (staff) + org.
  - `validateRoadtourToken(token)` → RPC `validate_roadtour_qr_token(p_token)` (server-side, never trusts client).
  - `buildRoadtourContextFromValidation(token, data)` — sanitises the resolved context.
- `app/src/lib/roadtour/url.ts` — `buildRoadTourPath` / `buildRoadTourUrl` (friendly canonical URLs).
- `app/src/lib/roadtour/duplicate-protection.ts`
  - `normalizeRoadtourParticipantPhone`, `isSameRoadtourParticipantPhone`,
    `getRoadtourDuplicateResponse`, duplicate policies (participant / shop / campaign / per-day / none).
- `app/src/lib/roadtour/registration-context.ts` — `sanitizeRoadtourRegistrationContext`.

### Schema (from `supabase/schemas/current_schema.sql`)
- `roadtour_campaigns` — `name`, `org_id`, `default_points`.
- `roadtour_campaign_managers` — staff assigned to a campaign.
- `roadtour_qr_codes` — `campaign_id`, `account_manager_user_id` (staff), `shop_id`,
  `token` (unique, `encode(gen_random_bytes(32),'base64url')`), `status`,
  `qr_mode` (`persistent|time_limited|one_time`), `expires_at`, `canonical_path`, `short_code`.
  → This is the "one QR per staff" precedent; a general booth QR is the same table with
    `account_manager_user_id` null/absent or a dedicated `qr_kind`.
- `roadtour_scan_events` — `account_manager_user_id`.
- `roadtour_official_visits` — `UNIQUE(campaign_id, account_manager_user_id, shop_id, visit_date)`.
- `roadtour_runs` — `org_id`, `start_date`, `end_date`, `status` (`draft|active|completed|cancelled`),
  `duplicate_policy`, `product_category_id`.

**Key lesson:** token resolution and staff attribution must happen server-side.
`validate_roadtour_qr_token` already returns staff/campaign from the token — Event Management
must mirror this and never accept a client-supplied staff id.

---

## 4. Identity, contacts & phone normalization

- `app/src/utils/phone.ts` + `app/src/utils/phone-core.ts`
  - `normalizePhoneE164(phone, defaultCountryCode='60')` → E.164 (`+601…`).
  - `toProviderPhone`, `maskPhone`, `phonesEqual`/`samePhone`, `formatPhoneDisplay`,
    `isValidE164Phone`, `isValidMalaysianPhone`.
  - Canonical contract (`docs/PHONE_NORMALIZATION_HARDENING.md`): store E.164 with `+`.
- `app/src/utils/phone-core.ts` is the app-local copy (Coolify builds don't depend on repo-root);
  `shared/phone/index.js` is the shared source.
- Migration `supabase/migrations/20260416_phone_normalization_hardening.sql` adds triggers/constraints
  and `public.phone_normalization_collision_report`.

### Identity entity
- `users` (id, email, full_name, phone w/ E.164 check, `principal_type`, `account_scope`,
  `email_normalized` generated as `identity_normalize_email(email)`).
  - `principal_type = 'CONSUMER'` ⇔ `account_scope = 'store'`.
  - `email_normalized` is the identity-resolution key (not a PK).
- **Anonymous submissions are stored inline today** (no auth user): `consumer_activations`
  (`consumer_phone`, `consumer_email`, `consumer_name`), `lucky_draw_entries` (same). This is the
  precedent for an event-specific contact entity rather than forcing a `users` row.

**Recommendation:** use an event-specific contact/registration entity and do **not** create auth
users or mutate `users` on anonymous submission. A nullable link to `users` (or a later identity
match) enables "new vs returning" without coupling anonymous data to auth.

### Registration rules (approved)
- **Mandatory:** name and Malaysian mobile phone. **Optional:** email, cat name, cat breed.
- **No** OTP or SMS verification in this version.
- Normalize to canonical E.164 `+60` via existing helpers (`normalizePhoneE164`).
- Validate Malaysian mobile format, length and supported prefixes server-side; client validation is
  immediate-feedback only.
- Reuse and inspect existing validation before proposing new logic; do **not** infer the telco from
  the prefix; format validation does not establish ownership or active service.
- **One normalized phone per event**; first successful registration source is fixed (including booth).
- Metrics describe **registrations**, not verified identities.

---

## 5. Business / brand / organization / program

- `organizations` — `org_type_code`, `parent_org_id` (hierarchy), `org_code`, `org_name`. Tenant/company scope.
- `brands` — `brand_code`, `brand_name`, `logo_url`, `is_active`.
- `loyalty_programs` — `organization_id`, `code` (`ellbow`), `name`, `active`.
- No dedicated `programs`/`businesses` table; "program" = `loyalty_programs`.

## 6. QR generation & public QR route conventions

- QR rendering: `qrcode` npm package — `app/src/app/api/roadtour/qr-image/[token]/route.ts`.
- Public scan entry: `app/src/app/scan/page.tsx` (reads `?rt=<token>`, resolves via `resolveRoadtourByToken`).
- Friendly URLs: `/roadtour/{year}/{campaignSlug}/{referenceSlugWithCode}` via `buildRoadTourPath`.
- `app/middleware.ts` `PUBLIC_PATHS` already whitelists `/scan`, `/api/roadtour/claim-reward`,
  `/api/roadtour/qr-image`, `/api/consumer`, `/track`, `/verify`, `/api/journey/default`, `/lp`, etc.
  Event Management public endpoints must be added here or the middleware will force auth.

---

## 7. Security & Access (S&A) — model, grouping, and base availability

### How S&A decides (verified)
- Permission keys are `module.resource.action` (3 dot-separated parts), enforced by a CHECK in
  `sa_permissions` (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`). Examples:
  `roadtour.campaign.manage`, `customer.campaign.manage`, `marketing.module.view`,
  `customer.report.view`, `ecommerce.module.view`.
- `sa_permissions` stores `module`, `resource`, `action`, `description`, `source`, `status`;
  `sa_migration_modes(permission_key, mode, legacy_permission_key, notes)` holds each key's mode.
- `authorizeOperation` → `authorize` (`app/src/lib/security-access/authorization.ts`) reads the key's
  mode, evaluates the legacy evaluator (when provided) plus the new policy, then applies
  `authoritativeOutcome`. Modes: `LEGACY_ENFORCED`/`SHADOW` (legacy decides) vs `NEW_ENFORCED`/
  `LEGACY_RETIRED` (S&A alone decides; a legacy ALLOW never overrides an S&A DENY).
- Legacy evaluators: `legacy-rules.ts` `legacyRoleLevelAtMost(userId, maxLevel)` (account_scope
  `portal` + `role.role_level <= max`) plus per-route rules (`stage2d-catalog.ts` `legacyRule`).
- Every decision is audited to `sa_authorization_decisions`.

### The ONE grouping that drives Policies / Group Policies / Migration Modes
`app/src/lib/security-access/modules.ts` → `MODULE_TAXONOMY` + `classifyPermission(key)` +
`groupByTaxonomy(...)`. Its comment states it is used by "Migration Modes, the Permission Catalogue,
Group Policies (details and editor) and People & Access". It is **display-only** (never grants).
- `customer_growth` group currently matches `mod('customer','roadtour','ecommerce','marketing')`
  with areas `crm`, `loyalty`, `messaging`, `roadtour`, `marketing`, `outdoor`, `ecommerce`.
- **Deferred (future granular-access phase):** Event Management would add a new area
  `{ id:'event', name:'Event Management', match: mod('event') }` and add `event` to the group's
  `mod(...)` match, so `event.*` keys classify as "Customer & Growth · Event Management" across
  Policies, Group Policies and Migration Modes. Not required for initial (parent-gate) access.
- `labels.ts` `permissionLabel` has a fallback; add `event: 'Customer & Growth'` to its `MODULE_GROUPS`
  map (and optionally `event.*` nouns to `RESOURCES`) for correct catalogue labels.

### Existing parent gate (verified on this base)
- Each Customer & Growth child module gates itself in its `_lib.ts` with `authorizeOperation` +
  `organizationResource` (org id server-derived, never request input):
  - `app/src/app/crm/_lib.ts` → `customer.crm.view`, `organizationResource('crm_module', orgId)`, legacy `HQ ≤ 50`.
  - `app/src/app/marketing/_lib.ts` → `marketing.module.view`, `organizationResource('marketing_module', orgId)`, legacy `HQ ≤ 30`.
  - `app/src/app/catalog/_lib.ts` → `product.catalog.view`, `organizationResource('catalog_module', orgId)`, legacy `HQ/DIST/SHOP ≤ 50`.
- **Gap:** there is **no** Customer & Growth domain-level parent permission — the domain landing
  (`app/src/app/customer-growth/_lib.ts`) returns `canViewCustomerGrowth = true` for all authenticated
  users and defers to each child module. The nearest verified parent gate for Event Management
  (placed under Marketing) is **`marketing.module.view`**.
- **Initial Event Management access** therefore reuses `marketing.module.view` for navigation, admin
  pages and APIs, with org isolation. Sidebar visibility alone is insufficient — every page/API
  re-checks. "Hiding navigation is not authorization".

### Database enforcement gap (Strategy B — deny direct DB access)
- The parent permission has **no DB equivalent usable inside RLS** for `authenticated`/`anon`:
  - S&A evaluation is server-side: `authorization.ts` `loadNewPolicy`/`evaluateNewPolicy` reads
    `sa_organization_memberships`, `sa_role_assignments`, `sa_business_role_permissions`,
    `sa_assignment_scopes` via the service-role client, and audits to `sa_authorization_decisions`.
  - The DB evaluator `public.sa_readable_organizations(actor, permission)` is `SECURITY DEFINER` but
    `REVOKE ALL … FROM public, anon, authenticated; GRANT EXECUTE … TO service_role` only
    (`20260930100000_sa_stage2d_deferred_closure.sql` lines 124–125). It cannot run inside an RLS
    policy evaluated for `authenticated`.
- **Chosen strategy:** deny direct access and route everything through server endpoints.
  - Tables: `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL … FROM public, anon, authenticated` (precedent:
    `inventory_cutoff_allocation_requests` in `20260801190000_inventory_cutoff_allocation_resolver.sql`).
  - RPCs: `SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO service_role` only
    (precedent: the `sa_*` functions and stock-count RPCs).
  - Admin endpoints verify `marketing.module.view` + org scope, then use the service-role client with
    explicit `organization_id` filtering + ownership checks. Public registration is token-scoped via
    the public endpoint. See IMPLEMENTATION_PLAN.md §4.

### Public QR registration is outside S&A
The public visitor has no `sa_organization_memberships` / `sa_role_assignments` / Group Policy, so
`authorizeOperation` would DENY. Public endpoints therefore resolve the token with the service-role/
admin client (like `resolveRoadtourByToken`) and never call `authorizeOperation`. Scanning a public QR
must not require — and must never grant — an admin Group Policy.

### Available on this base (`origin/staging`)
- `app/src/lib/security-access/operation.ts` — `authorizeOperation`, `guardOperation`,
  `guardUserOperation`, `organizationResource`, `warehouseResource`, `userAllowed`.
- `app/src/lib/security-access/modules.ts` — `MODULE_TAXONOMY` (display grouping). `customer_growth`
  group already has areas `crm`, `loyalty`, `messaging`, `roadtour`, `marketing`, `outdoor`, `ecommerce`.
  Event Management would add a new `event` area here **only in the deferred granular-access phase**.
- Permission catalogs `catalog.ts`, `stage2d-catalog.ts`; also present: `labels.ts`,
  `legacy-rules.ts`, `authorization.ts`, `enforcement.ts`.
- The `sa_permissions` + `sa_migration_modes` foundation is applied on staging/production
  (`20260927140000_sa_wave1_foundation.sql` and later per `PRODUCTION_MIGRATION_STATUS.md`), so
  registering `event.*` keys is a normal additive migration here.
- Registered permission keys (dot notation, seeded in `sa_permissions`) include:
  - `customer.campaign.manage`, `customer.consumer.view`, `customer.crm.view`,
    `customer.loyalty.adjust`, `customer.messaging.manage`, `customer.program.manage`,
    `customer.redemption.manage`, `customer.report.view`, `customer.reward.manage`,
    `customer.shop.manage`, `customer.support.manage/administer`, `customer.banner.manage`
  - `roadtour.campaign.manage`, `roadtour.kpi.manage`, `roadtour.report.view`, `roadtour.visit.manage`
  - `marketing.module.view`, `ecommerce.*`
- Export authorization precedent: `app/src/app/api/journey/download-qr-excel/route.ts` uses
  `guardUserOperation(userId, 'customer.campaign.manage')` + ExcelJS.
- `/api/security-access/me/capabilities`, `/api/security-access/me/request-options` exist.

### **`issues-fixing-oct2` only (NOT on this base)** — dependency to flag
- `app/src/lib/security-access/nav-access.ts` — `CUSTOMER_GROWTH_DESTINATIONS`, `NAV_DESTINATIONS`,
  `ROADTOUR_DESTINATIONS`, `SUPPLY_CHAIN_*`, `snapshotAllows`, `computeDestinations`,
  `productCatalogHome`, `customerGrowthChildVisible`, etc. This is where Event Management's
  sidebar/destination permission mapping belongs.
- `app/src/lib/server/nav-access.ts` — `resolveDestinationAccess` (server page guard for destinations).
- `app/src/lib/security-access/group-policies.ts` — Group Policies / module "Full Access" standard
  policies (`customer-growth-full-access` etc.) and drift reporting (`sa_standard_policy_drift`,
  `sa_extend_standard_policy`).
- `supabase/migrations/20261009100000_sa_group_policies_full_access.sql` — seeds the Full Access policies.
- `app/src/app/api/security-access/me/navigation/route.ts` — per-user navigation snapshot handler
  (the directory only holds `route.test.ts` on this base).
- `app/src/lib/security-access/bulk-modes.ts` + `app/src/app/api/security-access/modes/*` — Migration Modes UI.
- Also newer: `profiles.ts`, `scope-grant.ts`, `delegation.ts`, `ess-eligibility.ts`,
  `grant-identity.ts`, `system-logs-catalog.ts`, `user-admin-catalog.ts`.

**Evidence this base is incomplete:** `app/src/lib/security-access/nav-access.test.ts` exists on
`origin/staging` but imports `from './nav-access'`, whose source is absent here — so the
destination-based sidebar/permission layer is half-present.

**Implication:** initial Event Management access uses the existing `authorizeOperation`/
`guardUserOperation` + the Marketing parent gate `marketing.module.view` (no new `sa_permissions`
keys, no `MODULE_TAXONOMY` change needed). The richer destination-based nav snapshot and the
`event.*` granular permissions are only for a future phase and depend on `issues-fixing-oct2`.
Document that as a dependency for the future phase rather than merging the whole branch.

### Full Access coverage (precise)
The standard "Customer & Growth Full Access" (`customer-growth-full-access`, 23 explicit keys) and the
whole Group Policies / standard-policy mechanism are introduced by
`20261009100000_sa_group_policies_full_access.sql` + `group-policies.ts`, which exist **only on
`issues-fixing-oct2`** — not on `origin/staging`. Full Access holds an explicit, fixed key list and is
**not** auto-extended: newly registered keys surface via `sa_standard_policy_drift()` and require
`sa_extend_standard_policy(role_key, keys[], reason)`. **Conclusion:** `event.*` will NOT be covered by
Customer & Growth Full Access until explicitly extended. Surface the drift; do not silently modify grants.
This extension is **deferred** to the future granular-access phase (not required for initial access,
which uses the Marketing parent gate).

### Branch strategy for the deferred dependency (confirmed)
- The shared S&A framework on `issues-fixing-oct2` is required only for the **deferred** `event.*`
  granular-access phase, not for initial (parent-gate) access.
- Do **not** merge `issues-fixing-oct2` wholesale, move the Event Management module there, or build a
  parallel S&A/navigation framework.
- Preferred sequence (for the future phase): complete/validate shared S&A → integrate approved S&A to
  `staging` → update `event_management` from `staging` → add `event.*` against the shared framework.
- Selective cherry-picking of complete S&A dependency commits is an option **only after** dependency
  review; not authorized now. See README.md / HANDOFF.md.

## 8. Public form protections & rate limiting

- `app/src/lib/security/rate-limit.ts` — in-memory fixed-window limiter for unauthenticated endpoints:
  `checkRateLimit(key, limit, windowMs)`, `clientIpFromHeaders(headers)`, `resetRateLimitsForTests()`.
  Documented as a containment control (per-process, not distributed).
- No distributed/DB rate limiter observed for public forms; the RoadTour claim path uses server-side
  token validation as the primary gate.
- `app/src/lib/security/phase0b-public-endpoints.test.ts` tests bulk-enumeration limits.

---

## 9. Migration naming & discovery

- Migrations live in `supabase/migrations/` (273 files). Recent convention:
  `YYYYMMDDHHMMSS_description.sql` (14-digit); older: `YYYYMMDD_description.sql` (8-digit).
- **No automated runner / ledger.** `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md` states:
  production & staging have **no** `supabase_migrations.schema_migrations`; `public.migration_history`
  is business data, not a schema ledger. Migrations are applied **manually** and tracked there.
- The duplicate `20260928100000` version is explicitly called an "operational hazard for any
  filename/version-based runner".

### Requested `YYYYMMDD_eventNN_short_description.sql` — compatibility
- **Compatible with the manual flow.** `eventNN` preserves the module's manual execution order and is
  fine because order is documented, not inferred from a runner.
- Caveats:
  1. Lexicographic order vs existing files: `_eventNN_` sorts **after** same-day `HHMMSS` files
     (underscore `_` 0x5F > digits 0x30-0x39). A filename-sorting runner would run the module's files
     last that day — harmless here, but be explicit.
  2. Zero-padding: `event01`…`event99` sort correctly; don't exceed 99 without moving to `eventNNN`.
  3. The intended sequence (`event01`, `event02`, …) must be recorded in
     `PRODUCTION_MIGRATION_STATUS.md`; each file's header must state prerequisites and order
     (the user executes manually).
- **Recommendation:** keep `YYYYMMDD_eventNN_…` as requested (visible ordering preserved), document
  order in headers + status file. If a filename/version runner is ever reintroduced, switch to
  `YYYYMMDDHHMMSS_eventNN_…`.

---

## 10. Test conventions

- Runner: Vitest — `app/vitest.config.ts` includes `src/**/*.test.ts` and `src/**/*.test.tsx`, node
  environment, `@` → `src` alias, `server-only` → test stub.
- `app/package.json`: `"test": "vitest run"`.
- Colocated tests are the norm: `route.test.ts`, `*.test.tsx` next to source
  (`app/src/app/api/journey/engagement-trend/route.test.tsx`,
  `app/src/components/journey/JourneyBuilderV2.test.tsx`, `app/src/lib/security/*.test.ts`).
- **Caution:** `.gitignore` ignores `*.test.ts` / `*.test.js` / `*.spec.ts` and `**/__tests__/**` by
  default (lines 208-215). Security tests are re-included via explicit `!` rules (lines 217-230).
  Any new Event Management test file must be added with a matching `!` un-ignore rule (or `git add -f`).

## 11. Validation & shared UI

- Validation: `zod` is a dependency, but there is **no** dedicated `validation/` folder; validation is
  inline in route handlers plus small helpers (`app/src/lib/server/ellbow-catalog.ts` `requiredText`,
  `nonNegativeInteger`).
- Shared UI: `app/src/components/` (Radix primitives, `lucide-react`, `class-variance-authority`,
  `tailwind-merge`). Orange accents are the admin app's existing theme; reuse existing module shells
  (`EngagementShell`, `CustomerGrowthTopNav`, RoadTour views) rather than creating new primitives.

## 12. Material risks / gaps

1. **Dual nav systems** (`customer-growth` vs `marketing` modules) must both be reconciled so Event
   Management appears consistently in the overview card and top dropdown.
2. **S&A destination layer is half-present on this base** (see §7) — only needed for the future
   granular-access phase; initial sidebar visibility uses the Marketing parent gate `marketing.module.view`.
3. **Ellbow brand logo may only exist as DB data** (`brands.logo_url`) — a read-only technical
   verification, not a business decision; keep it pending if DB access is unavailable. Use the
   verified Journey Builder assets (see §2) as the design reference; do not invent paths or create
   brand data.
4. **Duplicate detection is now phone-mandatory:** `UNIQUE (event_id, phone_normalized)` on
   `event_contacts` plus `UNIQUE (event_id, contact_id)` on `event_registrations`; phone is
   `NOT NULL`, so there is no no-phone dedupe gap.
5. **Registration consent vs marketing consent** must stay separate; no consent table exists today
   (grep for "consent" found no domain model).



